# Stage 10X-U-B VehicleModel External Migration Enforcement

## 1. Goal

Stage 10X-U-B implements the external contract migration enforcement layer for deprecated `VehicleModel` enum usage.

This stage does not change Prisma schema, run migrations, delete enum values, rewrite data, change pricing, change quote/order behavior, change report results, or deploy to production.

## 2. Scope

Implemented:

- machine-readable external consumer registry;
- registry enforcement script;
- runtime external deprecation warning telemetry category;
- readiness scoring support for warning events;
- release check enforcement for registry coverage;
- documentation for governance and follow-up stages.

Not implemented:

- schema removal;
- enum deletion;
- API behavior changes;
- CSV column removal;
- ProductPriceRule uniqueness migration;
- production deployment.

## 3. Consumer Registry Enforcement

Registry file:

```text
docs/vehicle-model-external-contract-consumer-register.json
```

It registers the 9 external contract references reported by Stage 10X-T:

| Consumer id | Surface | Risk | Evidence path |
| --- | --- | --- | --- |
| `product-api-vehicle-model-contract` | API | Medium | `apps/api/src/product/dto/product.dto.ts` |
| `report-api-vehicle-model-filter` | API | Medium | `apps/api/src/report/dto/report.dto.ts` |
| `report-csv-vehicle-model-column` | CSV | Low | `apps/api/src/report/report.service.ts` |
| `residual-csv-legacy-model-fields` | CSV | Low | `apps/api/src/residual-market/residual-market.service.ts` |
| `vehicle-api-vehicle-model-contract` | API | Medium | `apps/api/src/vehicle/dto/vehicle.dto.ts` |
| `model-definition-api-legacy-mapping` | API | Medium | `apps/api/src/vehicle-model-definition/dto/vehicle-model-definition.dto.ts` |
| `asset-profitability-report-ui` | UI / CSV | Low | `apps/web/src/app/reports/asset-profitability/page.tsx` |
| `general-reports-ui` | UI / CSV | Low | `apps/web/src/app/reports/page.tsx` |
| `residual-market-ui` | UI / CSV | Low | `apps/web/src/app/residual-market/page.tsx` |

Enforcement command:

```powershell
pnpm vehicle-model:contract-governance
```

The command:

1. scans the codebase for external `VehicleModel` contract usage;
2. validates every scanned reference has a registry entry;
3. blocks warning-mode readiness when Medium / High consumers lack owner, replacement, or acceptable migration status;
4. writes `.tmp/vehicle-model-contract-governance-report.json`;
5. does not modify source files or database rows.

Current output:

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

- warning mode can start because all external references are registered and owned;
- hard enum removal is still not ready because consumers are not signed off or migrated.

## 4. Runtime Warning Telemetry

The runtime evidence model now supports:

```text
EXTERNAL_CONTRACT_DEPRECATION_WARNING
```

This usage kind is counted as external enum usage, not business-decision usage.

Expected event metadata:

```json
{
  "consumerId": "report-api-vehicle-model-filter",
  "deprecationStage": "warning",
  "field": "vehicleModel",
  "replacement": "modelDefinitionId",
  "surface": "REPORT_FILTER"
}
```

The helper:

```text
trackVehicleModelExternalContractWarning
```

is available for API/report/CSV warning-mode instrumentation.

Current resolver integration:

- when `VehicleModelLegacyAdapter.resolveModelDefinitionInput` receives deprecated report filter input through `API_ENUM_FILTER`, it emits an external contract warning event;
- the resolver behavior, validation, and output are unchanged.

## 5. Readiness Scoring

Warning events affect readiness like other external contract usage:

```text
businessDecisionUsageCount remains 0
fallbackUsageCount remains 0
externalUsageCount increases
decision remains NOT_READY while warning usage exists
```

Current static readiness output remains:

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

This is expected. Stage 10X-U-B enforces governance coverage; it does not claim enum removal readiness.

## 6. Release Gate

`pnpm release:check` now includes:

```text
VehicleModel external contract governance syntax
VehicleModel external contract governance
```

This prevents new external `vehicleModel` contract usage from landing without registry coverage.

## 7. Internal Scanner Boundary

The external usage scanner ignores internal VehicleModel evidence implementation files:

```text
vehicle-model-usage-tracker
vehicle-model-removal-readiness
vehicle-model-contract-governance
```

These files are governance infrastructure, not external consumers.

## 8. Rollback

Rollback is simple because this stage is telemetry and governance only:

1. remove release-check governance step if it blocks a hotfix;
2. keep registry file for audit;
3. keep runtime warning event type if already deployed because it does not change behavior;
4. revert to prior readiness scanner if governance validation has a false positive.

No database rollback is required.

## 9. Follow-Up

Recommended next stages:

| Stage | Goal |
| --- | --- |
| 10X-U-C | implement visible API/report warning mode and owner-facing migration reports |
| 10X-U-D | define CSV/report v1.1/v2 schema contracts and consumer validation |
| 10X-V | migrate ProductPriceRule uniqueness away from `vehicleModel` |
| 10X-W | deprecate Quote / Order enum snapshot reads |

## 10. No-op Confirmation

Stage 10X-U-B does not:

- change Prisma schema;
- add or run migrations;
- delete `VehicleModel`;
- modify data;
- change API payload behavior;
- remove CSV columns;
- change pricing, quote, order, product, portal, report, residual, ROE, depreciation, BaaS, payment, billing, contract, service-case, or write-off behavior;
- deploy to production.
