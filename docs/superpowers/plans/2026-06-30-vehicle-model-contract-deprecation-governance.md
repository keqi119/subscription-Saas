# VehicleModel External Contract Deprecation Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the governance artifacts and warning-mode preparation needed to migrate external `VehicleModel` API / CSV / report consumers away from enum contracts.

**Architecture:** Keep runtime behavior unchanged while adding explicit contract inventory, API deprecation documentation, CSV schema version governance, and warning-mode evidence design. `modelDefinitionId` remains the canonical runtime identity, while `vehicleModel` remains a deprecated compatibility contract until consumers migrate.

**Tech Stack:** Markdown governance docs, NestJS DTO documentation, Next.js report/export docs, existing `VehicleModelUsageTracker`, existing `vehicle-model:removal-readiness` script, pnpm release checks.

---

## File Structure

- Primary governance design: `docs/stage-10x-vehicle-model-contract-deprecation-governance.md`
- Consumer register: `docs/vehicle-model-external-contract-consumer-register.md`
- API deprecation notes: `docs/vehicle-model-api-contract-deprecation.md`
- CSV/report contract notes: `docs/vehicle-model-csv-report-contract-versioning.md`
- Runtime warning-mode implementation target: `apps/api/src/common/vehicle-model-usage-tracker.ts`
- API DTO implementation targets:
  - `apps/api/src/product/dto/product.dto.ts`
  - `apps/api/src/report/dto/report.dto.ts`
  - `apps/api/src/vehicle/dto/vehicle.dto.ts`
  - `apps/api/src/vehicle-model-definition/dto/vehicle-model-definition.dto.ts`
- Release evidence command: `pnpm vehicle-model:removal-readiness`

## Task 1: Create External Consumer Register

**Files:**
- Create: `docs/vehicle-model-external-contract-consumer-register.md`
- Modify: `docs/stage-10x-vehicle-model-contract-deprecation-governance.md`
- Test: documentation review and readiness command

- [ ] **Step 1: Create the register document**

Create `docs/vehicle-model-external-contract-consumer-register.md` with this content:

```markdown
# VehicleModel External Contract Consumer Register

This register tracks every known external contract that still exposes or consumes deprecated `vehicleModel` enum fields.

Governance rule:

```text
No VehicleModel schema removal work may begin until every Medium or High risk consumer is Signed off or has an approved non-enum exception.
```

| Consumer id | Owner | Surface | Current vehicleModel usage | Replacement | Risk | Migration status | Target date | Validation evidence | Rollback contact |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| product-api-vehicle-model-contract | Product owner | API | deprecated request/response compatibility in product DTOs | modelDefinitionId / modelDisplayName | Medium | Owner assigned | 2026-07-31 | product API client sample uses modelDefinitionId | Product owner |
| report-api-vehicle-model-filter | Finance owner | API | deprecated report vehicleModel filter | modelDefinitionId | Medium | Owner assigned | 2026-07-31 | report request sample uses modelDefinitionId | Finance owner |
| vehicle-api-vehicle-model-contract | Operations owner | API | deprecated vehicleModel response compatibility | modelDefinitionId / modelDisplayName | Medium | Owner assigned | 2026-07-31 | vehicle detail API response consumer confirmed canonical fields | Operations owner |
| model-definition-api-legacy-mapping | Platform owner | API | legacyVehicleModel metadata for governance mapping | modelCode / displayName / legacy mapping metadata | Medium | Exception requested | 2026-08-15 | platform owner confirms metadata remains admin-only | Platform owner |
| report-csv-vehicle-model-column | Finance owner | CSV | legacy vehicleModel column in reports | modelDefinitionId / modelDisplayName | Low | Owner assigned | 2026-07-31 | sample CSV parser reads canonical columns | Finance owner |
| residual-csv-legacy-model-fields | Asset owner | CSV | residual legacy brand/model fields | modelDefinitionId / modelDisplayName | Low | Owner assigned | 2026-07-31 | residual import template uses modelDefinitionId | Asset owner |
| asset-profitability-report-ui | Finance owner | UI / CSV | legacy report filter or export label | model-definition filter | Low | Owner assigned | 2026-07-31 | asset report UI defaults to model definition | Finance owner |
| general-reports-ui | Finance owner | UI / CSV | legacy report filter or export label | model-definition filter | Low | Owner assigned | 2026-07-31 | reports page uses modelDefinitionId filters | Finance owner |
| residual-market-ui | Asset owner | UI / CSV | legacy residual import/export fields | modelDefinitionId selector | Low | Owner assigned | 2026-07-31 | residual page uses modelDefinitionId selector | Asset owner |

Status values:

```text
Discovered
Owner assigned
Replacement documented
Consumer migrated
Validation evidence attached
Warning-mode clean
Signed off
Exception requested
Exception approved
Exception rejected
```
```

- [ ] **Step 2: Run readiness report**

Run:

```powershell
pnpm vehicle-model:removal-readiness
```

Expected:

```text
decision remains NOT_READY until externalUsageCount is zero or every remaining external usage has accepted governance status.
```

- [ ] **Step 3: Commit the register**

Run:

```powershell
git add docs/vehicle-model-external-contract-consumer-register.md docs/stage-10x-vehicle-model-contract-deprecation-governance.md
git commit -m "docs: add vehicle model external contract consumer register"
```

## Task 2: Document API Contract Deprecation

**Files:**
- Create: `docs/vehicle-model-api-contract-deprecation.md`
- Modify later: `apps/api/src/product/dto/product.dto.ts`
- Modify later: `apps/api/src/report/dto/report.dto.ts`
- Modify later: `apps/api/src/vehicle/dto/vehicle.dto.ts`
- Modify later: `apps/api/src/vehicle-model-definition/dto/vehicle-model-definition.dto.ts`
- Test: `pnpm release:check`

- [ ] **Step 1: Create API deprecation doc**

Create `docs/vehicle-model-api-contract-deprecation.md` with this content:

```markdown
# VehicleModel API Contract Deprecation

## Contract Rule

`vehicleModel` is deprecated in API contracts.

Canonical runtime identity:

```text
modelDefinitionId
```

Canonical runtime display:

```text
modelDisplayName
modelDefinition.displayName
modelDefinition.customerDisplayName
```

Canonical Quote / Order historical display:

```text
modelDisplayNameSnapshot
legacyVehicleModelCodeSnapshot
```

## Required Field Description

Use this wording for DTO comments or generated API descriptions:

```text
Deprecated. Compatibility only. Use modelDefinitionId for runtime model identity and snapshot display fields for Quote / Order historical explanation.
```

## v1 Behavior

```text
vehicleModel may remain in responses.
vehicleModel request filters may remain where already supported.
legacy-only operational writes remain rejected.
deprecated request usage must be tracked in warning mode.
```

## v2 Preview Behavior

```text
modelDefinitionId is required for model filtering.
vehicleModel request filters are removed or rejected.
vehicleModel response fields are optional compatibility echoes.
CSV exports use versioned schemas.
```

## Backward Compatibility Window

```text
60 production days after warning mode is enabled.
```

## Removal Gates

```text
businessDecisionUsageCount = 0
fallbackUsageCount = 0
API_ENUM_FILTER usage = 0 for 60 consecutive production days
all Medium and High API consumers are Signed off or Exception approved
```
```

- [ ] **Step 2: Add DTO comments**

For every DTO request field named `vehicleModel`, add this exact comment above the property:

```ts
/** @deprecated Compatibility only. Use modelDefinitionId for runtime model identity. */
```

For response DTO fields named `vehicleModel`, add:

```ts
/** @deprecated Compatibility echo. Use modelDefinitionId and modelDisplayName. */
```

- [ ] **Step 3: Run checks**

Run:

```powershell
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm release:check
```

Expected:

```text
API typecheck passes.
release check passes.
```

- [ ] **Step 4: Commit API docs**

Run:

```powershell
git add docs/vehicle-model-api-contract-deprecation.md apps/api/src/product/dto/product.dto.ts apps/api/src/report/dto/report.dto.ts apps/api/src/vehicle/dto/vehicle.dto.ts apps/api/src/vehicle-model-definition/dto/vehicle-model-definition.dto.ts
git commit -m "docs: mark vehicle model API contracts deprecated"
```

## Task 3: Design and Implement Warning-Mode Evidence

**Files:**
- Modify: `apps/api/src/common/vehicle-model-usage-tracker.ts`
- Modify tests: existing runtime evidence tests in `apps/api/test` or script tests under `scripts`
- Test: targeted tracker tests plus `pnpm vehicle-model:removal-readiness`

- [ ] **Step 1: Add warning usage kind**

Add this usage kind if the tracker uses string unions:

```ts
'EXTERNAL_CONTRACT_DEPRECATION_WARNING'
```

The warning event payload must include:

```ts
{
  field: 'vehicleModel',
  replacement: 'modelDefinitionId',
  surface: 'API_REQUEST' | 'API_RESPONSE' | 'CSV_EXPORT' | 'REPORT_FILTER',
  consumerId?: string,
  deprecationStage: 'warning',
}
```

- [ ] **Step 2: Track deprecated report filter usage**

When a report endpoint accepts a `vehicleModel` filter, record:

```ts
VehicleModelUsageTracker.record({
  module: 'report',
  operation: 'DEPRECATED_VEHICLE_MODEL_FILTER',
  usageKind: 'EXTERNAL_CONTRACT_DEPRECATION_WARNING',
  decisionPath: 'LEGACY_ENUM',
  riskLevel: 'MEDIUM',
  legacyVehicleModelCode: vehicleModel,
  metadata: {
    field: 'vehicleModel',
    replacement: 'modelDefinitionId',
    surface: 'REPORT_FILTER',
    deprecationStage: 'warning',
  },
});
```

- [ ] **Step 3: Add tracker test**

Add a test that records the warning event and expects the readiness report to count it as external usage, not business usage.

Expected assertion:

```ts
expect(report.businessDecisionUsageCount).toBe(0);
expect(report.externalUsageCount).toBeGreaterThan(0);
expect(report.decision).toBe('NOT_READY');
```

- [ ] **Step 4: Run checks**

Run:

```powershell
pnpm vehicle-model:removal-readiness
pnpm --filter @subscription-saas/api test
```

Expected:

```text
readiness report remains NOT_READY while warning usage exists.
API tests pass.
```

- [ ] **Step 5: Commit warning mode**

Run:

```powershell
git add apps/api/src/common/vehicle-model-usage-tracker.ts apps/api/test scripts
git commit -m "feat: track vehicle model contract deprecation warnings"
```

## Task 4: Define CSV / Report Contract Versioning

**Files:**
- Create: `docs/vehicle-model-csv-report-contract-versioning.md`
- Modify: `docs/reporting-metrics.md`
- Test: documentation review and `pnpm release:check`

- [ ] **Step 1: Create CSV contract doc**

Create `docs/vehicle-model-csv-report-contract-versioning.md` with this content:

```markdown
# VehicleModel CSV / Report Contract Versioning

## Canonical Columns

Runtime exports:

```text
modelDefinitionId
modelCode
modelDisplayName
```

Quote / Order historical exports:

```text
modelDefinitionIdSnapshot
modelDisplayNameSnapshot
legacyVehicleModelCodeSnapshot
```

Deprecated compatibility columns:

```text
vehicleModel
legacyVehicleModel
legacy brand
legacy series
legacy model
```

## Version Plan

| Version | Behavior |
| --- | --- |
| v1 | legacy and canonical columns both present |
| v1.1 | legacy columns documented as deprecated |
| v1.2 | warning-mode reports identify consumers still reading legacy columns |
| v2 preview | canonical columns first, legacy columns last |
| v2 stable | legacy columns optional or removed by export contract |

## Validation

```text
row counts remain unchanged
business identifiers remain unchanged
modelDefinitionId is populated when available
Quote / Order exports use snapshot display
legacy columns are not primary join keys
```
```

- [ ] **Step 2: Update reporting metrics doc**

Add this section to `docs/reporting-metrics.md`:

```markdown
## VehicleModel Contract Deprecation

Report and CSV model identity should use `modelDefinitionId`, `modelCode`, and display/snapshot fields.
Legacy `vehicleModel` columns remain compatibility-only until the VehicleModel contract deprecation window closes.
```

- [ ] **Step 3: Run checks**

Run:

```powershell
pnpm release:check
```

Expected:

```text
release check passes.
```

- [ ] **Step 4: Commit CSV docs**

Run:

```powershell
git add docs/vehicle-model-csv-report-contract-versioning.md docs/reporting-metrics.md
git commit -m "docs: define vehicle model CSV contract versioning"
```

## Task 5: Governance Gate Review

**Files:**
- Modify: `docs/stage-10x-vehicle-model-contract-deprecation-governance.md`
- Modify: `README.md`
- Test: `pnpm vehicle-model:removal-readiness`, `pnpm release:check`

- [ ] **Step 1: Re-run readiness report**

Run:

```powershell
pnpm vehicle-model:removal-readiness
```

Expected:

```text
businessDecisionUsageCount = 0
fallbackUsageCount = 0
decision remains NOT_READY while external contract usage exists
```

- [ ] **Step 2: Update README**

Add this entry to the Stage 10X docs list:

```markdown
- `docs/stage-10x-vehicle-model-contract-deprecation-governance.md`: Stage 10X-U-A external VehicleModel contract deprecation governance covering API deprecation, consumer registry, CSV/report versioning, warning mode, schema removal gates, and rollback strategy.
```

- [ ] **Step 3: Run release check**

Run:

```powershell
pnpm release:check
```

Expected:

```text
release check passes.
```

- [ ] **Step 4: Commit governance review**

Run:

```powershell
git add docs/stage-10x-vehicle-model-contract-deprecation-governance.md README.md
git commit -m "docs: add vehicle model contract deprecation governance"
```

## Self-Review Checklist

- [ ] API contract deprecation strategy covers deprecated fields, v1/v2 versioning, and compatibility window.
- [ ] CSV/report governance covers consumer registry, migration tracking, and CSV schema versioning.
- [ ] Warning mode design covers runtime warning triggers, telemetry, and deprecation logging.
- [ ] Schema removal gate covers zero-usage thresholds, consumer migration completion, and risk acceptance.
- [ ] Rollback strategy covers API rollback, CSV rollback, and schema rollback constraints.
- [ ] No task requires schema changes, migration execution, enum deletion, production deploy, or data modification for Stage 10X-U-A.
