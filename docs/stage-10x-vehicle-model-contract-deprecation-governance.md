# Stage 10X-U-A VehicleModel External Contract Deprecation Governance

## 1. Goal

Stage 10X-U-A defines the governance layer for retiring external `VehicleModel` enum contracts.

This stage is design-only. It does not change Prisma schema, run migrations, delete enum values, change runtime behavior, modify data, deploy to production, or change pricing / quote / order / report logic.

The plan starts from Stage 10X-T evidence:

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

- business logic is already free of enum dependency;
- fallback usage is currently zero;
- external API / CSV / report contracts still expose or accept legacy enum fields;
- schema removal remains blocked until external contracts are governed and migrated.

## 2. Governance Scope

The governance layer covers external-facing contracts only:

| Surface | Current risk | Governance action |
| --- | --- | --- |
| API request fields | Medium | mark `vehicleModel` deprecated, track usage, define v1/v2 behavior |
| API response fields | Medium | keep compatibility echo during deprecation window, document canonical replacement |
| Report filters | Medium | keep `vehicleModel` alias temporarily, warn and track usage |
| CSV exports | Low to Medium | version schema and migrate consumers to canonical columns |
| Residual import/export | Low to Medium | treat legacy brand/model fields as compatibility columns, not primary model identity |
| BI / spreadsheet consumers | Medium | register owners and migration status before warning mode |
| Internal support scripts | Low | register and migrate to `modelDefinitionId` / display snapshots |

Out of scope:

- schema removal;
- enum deletion;
- ProductPriceRule uniqueness migration;
- Quote / Order data rewrite;
- production data changes.

## 3. API Contract Deprecation Strategy

### 3.1 Field Policy

`vehicleModel` remains part of v1 compatibility contracts until the warning window closes.

Canonical fields:

```text
modelDefinitionId
modelDisplayName
modelDefinition.modelCode
modelDefinition.displayName
modelDefinition.customerDisplayName
modelDefinitionIdSnapshot
modelDisplayNameSnapshot
legacyVehicleModelCodeSnapshot
```

Deprecated compatibility fields:

```text
vehicleModel
legacyVehicleModel
legacyVehicleModelSnapshot
```

Required documentation text:

```text
Deprecated. Compatibility only. Use modelDefinitionId for runtime model identity and snapshot display fields for Quote / Order historical explanation.
```

### 3.2 Request Strategy

| API input pattern | Governance status | Required behavior during deprecation |
| --- | --- | --- |
| Create/update operational writes with `vehicleModel` only | Forbidden | continue rejecting; tell caller to send `modelDefinitionId` |
| Report filters with `vehicleModel` | Deprecated alias | accept temporarily, resolve through adapter, emit warning evidence |
| Read endpoints with `vehicleModel` in query | Deprecated alias | accept only where currently supported, emit warning evidence |
| Admin model-definition legacy mapping | Governance metadata | keep as internal compatibility metadata, not a new model creation path |

No request path should make a business decision from enum without resolving through the compatibility adapter.

### 3.3 Response Strategy

Responses may keep `vehicleModel` as a compatibility echo while clients migrate.

Response priority:

```text
canonical runtime identity: modelDefinitionId
canonical runtime display: modelDisplayName or modelDefinition.displayName
canonical historical display: modelDisplayNameSnapshot
compatibility code: legacyVehicleModelCodeSnapshot
deprecated compatibility echo: vehicleModel
```

Response deprecation rule:

```text
Do not remove vehicleModel from v1 responses until consumer register sign-off is complete and warning-mode evidence shows zero dependent consumers for the configured window.
```

### 3.4 API Versioning Strategy

Use contract versioning, not schema removal, as the first enforcement boundary.

| Version | Behavior | Purpose |
| --- | --- | --- |
| v1 | returns `vehicleModel`; accepts existing deprecated filters with warning evidence | preserve backward compatibility |
| v1 warning mode | same payload shape, emits structured deprecation warning when deprecated input is used | prove migration progress |
| v2 preview | uses `modelDefinitionId` and display/snapshot fields as canonical; may omit deprecated request filters | prepare consumers |
| v2 stable | no deprecated enum request inputs; response compatibility fields are optional or moved to legacy section | contract cleanup |

Recommended v1 warning response metadata:

```text
X-Deprecated-Field: vehicleModel
X-Replacement-Field: modelDefinitionId
X-Deprecation-Stage: vehicle-model-contract-warning
```

The metadata is a design target for a later implementation stage. Stage 10X-U-A does not add headers.

### 3.5 Backward Compatibility Window

Default compatibility window:

```text
60 production days after warning mode is enabled
```

Minimum exit criteria:

```text
businessDecisionUsageCount = 0
fallbackUsageCount = 0
API_ENUM_FILTER usage = 0 for 30 consecutive production days
externalUsageCount = 0 or every remaining consumer has signed an accepted exception
all high/medium API consumers have owner sign-off
```

## 4. CSV / Report Consumer Governance

### 4.1 External Consumer Registry

Create a registry before warning mode implementation.

Recommended file:

```text
docs/vehicle-model-external-contract-consumer-register.md
```

Registry columns:

| Column | Meaning |
| --- | --- |
| `consumerId` | stable id, for example `finance-asset-profitability-csv` |
| `owner` | named team or person accountable for migration |
| `surface` | API, CSV, report UI, BI job, spreadsheet, support script |
| `currentVehicleModelUsage` | request filter, response field, CSV column, manual lookup, or display-only |
| `replacement` | `modelDefinitionId`, `modelDisplayName`, snapshot display, or string code snapshot |
| `risk` | High, Medium, Low |
| `migrationStatus` | Not started, In progress, Migrated, Exception accepted |
| `targetDate` | agreed migration date |
| `validationEvidence` | link to test, screenshot, runbook, or owner confirmation |
| `rollbackContact` | owner to contact if warning mode causes failure |

Initial register seed from Stage 10X-T evidence:

| Consumer id | Surface | Evidence path | Risk | Replacement |
| --- | --- | --- | --- | --- |
| `product-api-vehicle-model-contract` | API | `apps/api/src/product/dto/product.dto.ts` | Medium | `modelDefinitionId` |
| `report-api-vehicle-model-filter` | API | `apps/api/src/report/dto/report.dto.ts` | Medium | `modelDefinitionId` |
| `vehicle-api-vehicle-model-contract` | API | `apps/api/src/vehicle/dto/vehicle.dto.ts` | Medium | `modelDefinitionId` |
| `model-definition-api-legacy-mapping` | API | `apps/api/src/vehicle-model-definition/dto/vehicle-model-definition.dto.ts` | Medium | `modelCode` + governance metadata |
| `report-csv-vehicle-model-column` | CSV | `apps/api/src/report/report.service.ts` | Low | model code + display columns |
| `residual-csv-legacy-model-fields` | CSV | `apps/api/src/residual-market/residual-market.service.ts` | Low | `modelDefinitionId` + display |
| `asset-profitability-report-ui` | UI / CSV | `apps/web/src/app/reports/asset-profitability/page.tsx` | Low | model-definition filter |
| `general-reports-ui` | UI / CSV | `apps/web/src/app/reports/page.tsx` | Low | model-definition filter |
| `residual-market-ui` | UI / CSV | `apps/web/src/app/residual-market/page.tsx` | Low | model-definition selector |

### 4.2 Migration Tracking

Migration state machine:

```text
Discovered
Owner assigned
Replacement documented
Consumer migrated
Validation evidence attached
Warning-mode clean
Signed off
```

Blocked states:

```text
No owner
Unknown usage
Requires legacy enum
Exception requested
Exception approved
Exception rejected
```

Warning mode cannot start while any Medium or High consumer is in:

```text
No owner
Unknown usage
Requires legacy enum
```

Hard removal cannot start while any consumer is not:

```text
Signed off
Exception approved with non-enum replacement
```

### 4.3 CSV Schema Versioning

CSV exports should move through additive versioning.

Recommended export metadata:

```text
schemaVersion: vehicle-model-contract-v1
deprecatedColumns: vehicleModel, legacy vehicleModel, legacy brand/model
replacementColumns: modelDefinitionId, modelCode, modelDisplayName, modelDisplayNameSnapshot
```

CSV version phases:

| Version | Columns | Behavior |
| --- | --- | --- |
| v1 | legacy + canonical columns | current compatibility mode |
| v1.1 | legacy columns marked deprecated in docs and metadata | soft deprecation |
| v1.2 | warning report lists consumers still reading legacy columns | warning mode |
| v2 preview | canonical columns first, legacy columns at end | consumer validation |
| v2 stable | legacy columns optional or removed by export contract | removal window |

CSV validation requirements:

```text
row count unchanged
vehicle/order identifiers unchanged
modelDefinitionId populated where runtime object has modelDefinitionId
Quote / Order exports use snapshot display for historical rows
legacy columns are never used as pricing or grouping truth
```

## 5. Warning Mode System Design

### 5.1 Warning Events

Warning mode should use the existing runtime evidence concepts.

Recommended event category:

```text
EXTERNAL_CONTRACT_DEPRECATION_WARNING
```

Recommended metadata:

```json
{
  "field": "vehicleModel",
  "replacement": "modelDefinitionId",
  "surface": "API_REQUEST | API_RESPONSE | CSV_EXPORT | REPORT_FILTER",
  "consumerId": "report-api-vehicle-model-filter",
  "route": "/api/reports/asset-profitability",
  "owner": "finance",
  "deprecationStage": "warning",
  "schemaVersion": "vehicle-model-contract-v1.1"
}
```

### 5.2 Warning Triggers

Emit warning evidence when:

- an API request sends `vehicleModel` as a filter or input;
- a report request uses deprecated `vehicleModel` query params;
- a CSV export includes legacy enum columns for a registered consumer;
- a backend compatibility adapter resolves external enum input;
- a frontend sends legacy enum filters instead of modelDefinitionId.

Do not emit warning evidence for:

- internal schema compatibility fields that are system-derived;
- historical snapshot rendering;
- display-only legacy labels when no external contract input is involved;
- enum freeze guard parsing.

### 5.3 Warning Channels

Recommended channels:

| Channel | Purpose |
| --- | --- |
| runtime tracker event | readiness score and usage trend |
| structured application log | production observability |
| optional response header | API caller debugging |
| daily readiness report | governance dashboard |
| consumer register status update | owner accountability |

Stage 10X-U-A designs the channels only. Later stages decide which channels are implemented.

### 5.4 Deprecation Logging Rules

Logging must not include:

- personally identifiable customer data;
- full request bodies;
- payment data;
- contract URLs;
- credentials or tokens.

Logging should include:

- route or export name;
- consumer id if known;
- deprecated field name;
- replacement field name;
- count and timestamp bucket;
- risk classification.

Recommended aggregation:

```text
per day
per surface
per consumer id
per deprecated field
```

## 6. Schema Removal Gate Refinement

### 6.1 Contract Zero-Usage Threshold

Strict hard removal threshold:

```text
businessDecisionUsageCount = 0
fallbackUsageCount = 0
externalUsageCount = 0
API_ENUM_FILTER usage = 0 for 60 consecutive production days
CSV legacy primary-field usage = 0 for 60 consecutive production days
all consumer register entries are Signed off or Exception approved with non-enum replacement
readinessScore = 100
```

Warning-mode entry threshold:

```text
businessDecisionUsageCount = 0
fallbackUsageCount = 0
all Medium/High consumers have owners
all replacements are documented
readinessScore >= 90 or manual architecture acceptance recorded
```

### 6.2 Consumer Migration Completion

A consumer is considered migrated only when all are true:

```text
consumer no longer sends vehicleModel in requests
consumer uses modelDefinitionId or snapshot display as documented
consumer export parser does not require legacy enum columns as primary key
consumer owner has validation evidence
consumer has rollback contact
```

Display-only legacy columns can remain during v1 if:

```text
they are documented as deprecated
they are not used as join keys
they are not used for pricing, filtering, or grouping decisions
they have an accepted removal or long-term compatibility decision
```

### 6.3 Risk Acceptance Criteria

Risk can be accepted only for Low-risk display/export compatibility.

Non-acceptable risks:

- any enum business decision;
- any enum pricing decision;
- any external write path that requires `vehicleModel`;
- any report filter that cannot migrate to `modelDefinitionId`;
- any CSV consumer using enum as a primary join key without replacement.

Accepted exception record must include:

```text
consumer id
reason
owner
expiry date
replacement plan
risk signer
rollback contact
```

## 7. Rollback Strategy

### 7.1 API Rollback Plan

Soft deprecation rollback:

```text
remove warning headers or warning logs
keep behavior unchanged
keep vehicleModel fields
```

Warning-mode rollback:

```text
disable warning response metadata
continue recording internal evidence if safe
restore previous API docs if external clients are blocked
keep adapter behavior unchanged
```

Contract-removal rollback:

```text
restore v1 route or v1 response shape
restore deprecated request alias handling
do not modify schema during rollback
compare response samples before and after rollback
```

### 7.2 CSV Rollback Plan

CSV v1.1 / v1.2 rollback:

```text
restore previous column order
restore legacy column names
keep canonical columns if already additive
notify registered owners
```

CSV v2 rollback:

```text
switch export default back to v1
keep v2 as opt-in preview
verify row counts and key columns
restore downstream BI job schedule only after owner confirmation
```

### 7.3 Schema Rollback Constraints

Schema rollback is not part of Stage 10X-U-A.

Future hard removal rollback constraints:

- destructive enum removal cannot be safely rolled back without backup and migration rehearsal;
- API/CSV rollback must be available before schema rollback is considered;
- schema hard removal requires production-like clone rehearsal;
- no enum schema removal should happen in the same release as first warning mode or first CSV v2 rollout.

## 8. Governance Workflow

Recommended sequence:

1. create external consumer register;
2. assign owners to every Stage 10X-T external reference;
3. publish API and CSV deprecation notes;
4. implement warning-mode telemetry in a later stage;
5. run daily readiness report;
6. review register weekly until every Medium/High consumer is migrated or has accepted exception;
7. open v2 preview contracts;
8. start removal window only after zero-usage thresholds are met;
9. run schema removal dry-run in isolated branch;
10. decide whether enum removal is still worth the risk.

## 9. Follow-Up Stages

| Stage | Goal | Schema change? | Risk | Exit criteria |
| --- | --- | --- | --- | --- |
| 10X-U-B | implement consumer register and API deprecation documentation | No | Low | all Stage 10X-T surfaces have owners or explicit unowned risk |
| 10X-U-C | implement warning-mode evidence for deprecated API/report inputs | No | Medium | daily report shows per-consumer deprecated usage |
| 10X-U-D | define CSV/report v1.1/v2 schema contract and owner validation | No | Medium | consumers can test canonical columns |
| 10X-V | migrate ProductPriceRule uniqueness to modelDefinitionId | Yes | High | pricing uniqueness no longer depends on enum |
| 10X-W | deprecate Quote / Order enum snapshot reads | Maybe | Medium | string snapshots are sufficient for display/reporting |
| 10X-X | final enum removal dry-run | Yes, dry-run only first | High | readiness score 100 and clone rehearsal passes |

## 10. No-op Confirmation

Stage 10X-U-A does not:

- change Prisma schema;
- add or run migrations;
- delete `VehicleModel`;
- modify data;
- change API behavior;
- change CSV output;
- change report filters;
- change pricing, quote, order, product, portal, residual, ROE, depreciation, BaaS, payment, billing, contract, service-case, or write-off logic;
- deploy to production.
