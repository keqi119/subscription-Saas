# Stage 10X-U VehicleModel Schema Contract Deprecation Plan

## 1. Goal

Stage 10X-U defines the contract deprecation path for the frozen `VehicleModel` enum.

This stage is planning only. It does not change Prisma schema, run migrations, delete enum values, modify data, change API behavior, deploy to production, or alter pricing / quote / order / report logic.

The plan starts from Stage 10X-T runtime evidence:

```json
{
  "enumUsageCount": 9,
  "businessDecisionUsageCount": 0,
  "fallbackUsageCount": 0,
  "externalUsageCount": 9,
  "readinessScore": 0,
  "decision": "NOT_READY"
}
```

Interpretation:

- runtime business logic no longer shows legacy enum dependency;
- runtime fallback evidence is currently zero;
- API / CSV / external-facing contracts still expose or consume legacy enum fields;
- schema contract deprecation is not ready for hard removal.

## 2. Current Contract Surface

Stage 10X-T identified these remaining contract surfaces:

| Category | Path | Risk | Deprecation impact |
| --- | --- | --- | --- |
| API contract | `apps/api/src/product/dto/product.dto.ts` | Medium | product quote / package / price-rule clients may still send or read `vehicleModel` |
| API contract | `apps/api/src/report/dto/report.dto.ts` | Medium | report callers may still use legacy `vehicleModel` filters |
| API contract | `apps/api/src/vehicle/dto/vehicle.dto.ts` | Medium | vehicle create/update DTOs still expose deprecated `vehicleModel` compatibility fields |
| API contract | `apps/api/src/vehicle-model-definition/dto/vehicle-model-definition.dto.ts` | Medium | model-definition admin API still exposes legacy mapping metadata |
| CSV export | `apps/api/src/report/report.service.ts` | Low | report CSV still includes legacy model compatibility columns |
| CSV export | `apps/api/src/residual-market/residual-market.service.ts` | Low | residual CSV still includes legacy brand/model compatibility fields |
| CSV/UI export client | `apps/web/src/app/reports/asset-profitability/page.tsx` | Low | frontend export filters and column labels retain legacy model fields |
| CSV/UI export client | `apps/web/src/app/reports/page.tsx` | Low | order / finance / vehicle report UI retains legacy model filters or drilldowns |
| CSV/UI export client | `apps/web/src/app/residual-market/page.tsx` | Low | residual import/export UI retains legacy fields |

The current dependency is therefore a contract and compatibility problem, not a live pricing correctness problem.

## 3. API Contract Analysis

### 3.1 Response Fields

`vehicleModel` can remain in responses during deprecation because removing response fields is breaking for:

- existing admin frontend pages;
- external report consumers;
- CSV post-processing scripts;
- customer support exports;
- internal QA fixtures.

Recommended response policy:

```text
modelDefinitionId / modelDisplayName / snapshot display = canonical
vehicleModel = deprecated compatibility echo
legacyVehicleModelCodeSnapshot = historical code explanation
```

New response docs should mark `vehicleModel` as:

```text
Deprecated. Compatibility only. Do not use for business decisions. Use modelDefinitionId or snapshot display fields.
```

### 3.2 Request Fields

Request fields have higher risk than responses because callers can still express business intent with enum values.

Current posture:

- core write paths reject legacy-only `vehicleModel`;
- report filters still accept `vehicleModel` and resolve through `VehicleModelLegacyAdapter`;
- direct quote compatibility paths can still accept legacy input but trace it through runtime evidence.

Recommended request policy:

| Request type | 10X-U status | Future action |
| --- | --- | --- |
| create/update writes | keep rejecting legacy-only enum input | no behavior change needed |
| report filters | keep accepting with deprecation warning period | migrate callers to `modelDefinitionId` |
| admin compatibility filters | keep accepting temporarily | remove only after usage evidence is zero |
| external integrations | inventory before deprecation | require owner acknowledgement |

### 3.3 Backward Compatibility Requirements

Before removing enum request contracts:

1. all external clients must support `modelDefinitionId`;
2. all generated API docs must mark `vehicleModel` as deprecated;
3. API logs or telemetry must show legacy enum request usage is zero for the agreed observation window;
4. customer-support CSV workflows must no longer require enum values as their primary join key;
5. frontend filters must default to model master data and hide legacy enum filters behind compatibility affordances or remove them.

## 4. CSV / Report Dependency

### 4.1 Current Dependency

CSV/report dependencies are lower runtime risk because they are primarily output compatibility. They still block schema deletion because downstream users may parse legacy columns.

Current compatibility columns include forms of:

```text
legacy 车型
vehicleModel
legacy model
brand / series / model
```

### 4.2 Migration Strategy

Use additive CSV evolution:

1. keep existing legacy columns;
2. ensure canonical columns exist:
   - `车型代码`
   - `车型显示名`
   - `modelDefinitionId` where internal export is allowed;
   - snapshot display fields for Quote / Order historical exports;
3. publish deprecation notice for legacy enum columns;
4. add export metadata or documentation that says legacy columns are compatibility-only;
5. collect consumer acknowledgements;
6. after usage is zero, move legacy columns to the end or mark as optional;
7. remove legacy columns only in a major export contract version.

### 4.3 Report API Strategy

Report APIs should keep this order:

```text
filter by modelDefinitionId
accept vehicleModel only as deprecated alias
resolve alias through VehicleModelLegacyAdapter
record API_ENUM_FILTER evidence
```

Removal condition:

```text
API_ENUM_FILTER usage = 0 for observation window
```

## 5. External Dependency Sweep

Stage 10X-U should create an external contract register before any warning mode begins.

Each consumer record should include:

```text
consumer name
owner
contract type: API / CSV / manual report / BI import
current vehicleModel usage
replacement field
migration status
target date
sign-off status
rollback contact
```

Minimum external sweep scope:

- report CSV consumers;
- finance / asset profitability exports;
- residual market CSV import/export users;
- external BI jobs;
- partner or webhook payloads;
- manually maintained spreadsheets that parse `vehicleModel`;
- QA and support scripts.

## 6. Schema Removal Gate

Hard enum removal is not allowed until all gates are green.

### 6.1 Safe Removal Conditions

Required:

```text
businessDecisionUsageCount = 0
fallbackUsageCount = 0
externalUsageCount = 0 or formally accepted for a non-enum string replacement
readinessScore = 100 for hard removal
VehicleModel enum freeze still passing
all API request contracts are modelDefinitionId-first
all CSV contract owners have migrated or signed off
ProductPriceRule uniqueness no longer depends on vehicleModel
Quote / Order historical explanation does not require enum fields
schema dry-run removal passes prisma validate/generate/typecheck/tests in an isolated branch
production-like clone rehearsal passes
rollback rehearsal completed
```

### 6.2 Risk Thresholds

| Gate | Soft deprecation | Warning mode | Hard removal |
| --- | --- | --- | --- |
| `businessDecisionUsageCount` | 0 | 0 | 0 |
| `fallbackUsageCount` | 0 | 0 | 0 |
| `externalUsageCount` | allowed if inventoried | trending to zero | 0 |
| readiness score | >= 90 | >= 95 | 100 |
| API legacy filter usage | allowed | warning only | 0 |
| CSV legacy column usage | allowed | signed migration | 0 or versioned contract removed |
| schema hard dependency | allowed | allowed | removed only after dry-run |

### 6.3 Rollback Strategy

Use expand-contract discipline:

1. do not delete enum fields in the same stage that removes API usage;
2. keep old response fields through at least one release after warnings begin;
3. add replacement string/modelDefinition fields before removing enum fields;
4. perform schema removal only after production-like clone rehearsal;
5. keep database backup and migration rollback scripts ready;
6. if post-release fallback or contract errors appear, rollback application code first while leaving schema compatible;
7. only rollback destructive schema after backup validation and manual approval.

Rollback must preserve:

- historical Quote / Order interpretability;
- report / CSV row counts;
- ProductPriceRule lookup correctness;
- vehicle / package display fallback.

## 7. Deprecation Timeline

### Phase 1: Soft Deprecation

Duration:

```text
1 release cycle
```

Actions:

- update API docs and DTO descriptions;
- document replacement fields;
- keep behavior unchanged;
- keep response `vehicleModel`;
- collect runtime evidence daily;
- publish CSV deprecation notes.

Exit:

```text
businessDecisionUsageCount = 0
fallbackUsageCount = 0
external consumers inventoried
```

### Phase 2: Warning Mode

Duration:

```text
30 to 60 production days
```

Actions:

- emit warnings when deprecated `vehicleModel` request filters are used;
- add response headers or structured logs for deprecated API usage if appropriate;
- keep CSV columns but mark them compatibility-only;
- track `API_ENUM_FILTER` and `EXTERNAL_CONTRACT` usage;
- require migration dates from owners.

Exit:

```text
legacy request usage = 0
CSV consumers migrated or signed off
readinessScore >= 95
```

### Phase 3: Contract Removal Window

Duration:

```text
1 planned major contract release
```

Actions:

- remove legacy request acceptance in a non-schema stage;
- keep response compatibility fields if needed as strings;
- version CSV exports if legacy columns are removed;
- run dual-read validation and report row-count validation;
- maintain rollback to prior contract behavior.

Exit:

```text
readinessScore = 100
externalUsageCount = 0
schema hard blockers only remain as internal storage compatibility
```

### Phase 4: Schema Removal Dry-Run

Actions:

- create isolated branch that removes enum fields and enum definition;
- replace remaining enum snapshots with string fields;
- redesign ProductPriceRule uniqueness if not already done;
- run full test / build / release checks against production-like clone;
- do not deploy.

Exit:

```text
prisma validate/generate pass
all tests pass
report exports pass
rollback rehearsal passes
manual sign-off complete
```

### Phase 5: Hard Removal

Only after all previous gates:

- remove enum schema;
- deploy during approved maintenance window;
- monitor evidence counters;
- verify CSV/API compatibility;
- keep rollback ready.

## 8. Required Follow-Up Stages

| Stage | Goal | Migration? | Risk | Recommended timing |
| --- | --- | --- | --- | --- |
| 10X-U-A | API docs and consumer register for deprecated `vehicleModel` contracts | No | Low | Next |
| 10X-U-B | warning mode for deprecated enum request filters | No | Medium | After consumer register |
| 10X-U-C | CSV/report compatibility versioning plan | No | Medium | Parallel with warning mode |
| 10X-V | ProductPriceRule uniqueness migration design | Yes | High | Before any schema removal |
| 10X-W | Quote / Order enum snapshot read deprecation | Possibly | Medium | After string snapshot adoption is confirmed |
| 10X-X | final schema removal dry-run | Yes, dry-run only | High | Only after evidence score 100 |

## 9. Manual Confirmation Items

- Which API clients are allowed to keep reading `vehicleModel` responses indefinitely?
- Are CSV legacy columns contractual, or can they be versioned out?
- What production observation window is required: 30, 60, or 90 days?
- Who owns each external report / BI / spreadsheet consumer?
- Is a readiness score of 95 acceptable for warning mode, or must it be 100 before warnings?
- Should hard removal require a major version label for APIs and CSVs?

## 10. No-op Confirmation

This plan does not:

- modify Prisma schema;
- add or run migrations;
- delete `VehicleModel`;
- modify database rows;
- change API behavior;
- change CSV output;
- change pricing, quote, order, product, portal, report, residual, ROE, depreciation, BaaS, payment, billing, or write-off logic;
- deploy to production.
