# Fleet Ops P2 Pool Overview & Dynamic Cohort Design

## 1. 总览

### 1.1 P1 Current State

Fleet Ops P1 has reached production as a controlled read-only diagnostic capability.

- The production API/Web path is enabled through `FLEET_OPS_API_ENABLED`.
- Access is limited to internal/admin users with `fleet_ops:read`.
- The current `/fleet-ops` page can load a single-vehicle Fleet Ops snapshot.
- P1-H23 added a read-only vehicle lookup and drilldown entry, so users can search by internal vehicle ID, vehicle number, VIN, or license plate.
- The current surface remains read-only and exposes no execution, mutation, customer, or public controls.

The current product limitation is that single-vehicle diagnosis helps investigation, but it is not enough for recurring fleet management.

### 1.2 P2 Business Goal

P2 moves Fleet Ops from single-vehicle diagnostic toward pool and dynamic cohort management:

```text
vehicle pool / dynamic cohort overview
  -> anomaly ranking
  -> vehicle list
  -> single-vehicle snapshot drilldown
```

The first P2 design target is an operator-facing overview that shows overall fleet posture, supports formal pool and temporary cohort scopes, summarizes KPI/risk/data-quality status, ranks anomalies, and keeps the existing single-vehicle snapshot as the detail drilldown.

### 1.3 Key Product Flow

1. Open Fleet Ops overview.
2. Choose a vehicle scope: all permitted vehicles, a formal vehicle pool, or a dynamic cohort.
3. Apply read-only filters.
4. Review KPI, risk, overdue, cashflow, and data-quality summaries.
5. Review anomaly rankings.
6. Open a vehicle list or anomaly row.
7. Drill into the existing single-vehicle snapshot through `/fleet-ops?vehicleId=<id>`.

### 1.4 Terminology

| Term | Definition | Examples | P2 Status |
| --- | --- | --- | --- |
| 车辆池 / Vehicle Pool | Formal system-owned grouping. It is suitable for official reporting, finance/asset review, risk exposure review, and recurring business review. | asset pool, financing pool, revenue-right pool, management pool, system vehicle pool | In scope |
| 车辆分群 / Dynamic Cohort | Temporary analysis scope built from filters. It is not persisted and has no ownership/sharing behavior. | brand/model/year, operating state, risk level, D1-D5 aging, confidence band | In scope |
| 自定义视图 / Saved Custom View | Persisted personal or team analysis view. | named saved filter set, shared team view | P3 only |

### 1.5 Explicit P3 Deferral

Saved custom views are deferred until P2 proves whether dynamic filters are insufficient.

Saved views require separate design for write scope, ownership, audit trail, permission policy, sharing model, update/delete semantics, and persistence. P2-H1, P2-H2, and P2-H3 must not implement saved custom views or saved-view persistence.

## 2. 分段计划

### 2.1 P2-H1A: Terminology And Scope Design

Vehicle Pool / 车辆池 is a formal system grouping. The first supported source should be `VehicleAssetPool` and active `VehicleAssetPoolVehicle` membership when present. Future mapping can include financing pools, revenue-right pools, and management/system pools, but those mappings need explicit semantic review.

Dynamic Cohort / 车辆分群 is a temporary filter-built analysis scope. It supports operational analysis and anomaly discovery without saving, sharing, or writing any view state.

Saved Custom View / 自定义视图 is P3 only. It is not part of P2-H1/H2/H3 because it requires persistence and write-scope governance.

### 2.2 P2-H1B: KPI And Aggregation Rules

The overview should define and document these metric groups:

- Counts: total vehicles, active/operating, idle/available, abnormal, overdue, missing-data or low-confidence.
- Economics: revenue, cost, net income, ROI, ROE, denominator evidence, low ROI vehicles.
- Cashflow: actual operating cashflow, actual deposit cashflow, planned operating cashflow, planned deposit cashflow, unallocated cashflow.
- Deposit treatment: deposits are displayed separately and excluded from operating revenue.
- Risk and overdue: overdue amount, overdue vehicle count, overdue bill count, max overdue days, D1-D5 distribution, collection priority distribution, high-risk vehicles.
- Data quality: average confidence, minimum confidence, low-confidence count, warning count, missing evidence count, timeline fallback count, consistency score.
- Anomaly lists: highest overdue exposure, highest risk, lowest ROI, lowest confidence, evidence missing, cashflow anomaly, timeline fallback.

Aggregation rules must preserve existing Fleet Ops semantics. ROI/ROE must use total-based aggregation and must not be a simple average of vehicle-level ROI/ROE.

### 2.3 P2-H1C: API Contract Design

Future P2 endpoints should be GET-only and remain behind `fleet_ops:read` plus `FLEET_OPS_API_ENABLED`.

Recommended endpoints:

- `GET /fleet-ops/overview`
- `GET /fleet-ops/pools`
- `GET /fleet-ops/pools/:poolId`
- Optional future endpoint: `GET /fleet-ops/vehicles` for scoped vehicle and anomaly lists.

The existing P1-H23 `GET /fleet-ops/vehicles/lookup` should remain a lightweight identity lookup. It should not become the pool/cohort metric list endpoint.

### 2.4 P2-H1D: Frontend Information Architecture

The safest first route strategy is:

- `/fleet-ops` remains the current single-vehicle diagnostic route.
- `/fleet-ops/overview` becomes the new pool/cohort overview route.
- `/fleet-ops/pools` lists formal system pools.
- `/fleet-ops/pools/:poolId` shows formal pool detail.
- `/fleet-ops?vehicleId=<id>` remains the initial single-vehicle drilldown target.

Future `/fleet-ops/vehicles/:vehicleId` can be evaluated after the overview flow is stable, but it is not required for the first P2 rollout.

### 2.5 P2-H1E: Testing And Rollout Plan

P2-H1 is docs/design-only. It must not implement runtime API, runtime UI, schema, migrations, permissions, seed, sync, package scripts, CI, Dockerfiles, or deployment configuration.

P2-H2 should implement the read-only backend aggregation surface:

- scope resolver
- pool/cohort contracts
- overview service
- pool aggregator
- API contract tests
- read-only and boundary tests

P2-H2 implementation note:

- MVP endpoints are `GET /fleet-ops/overview`, `GET /fleet-ops/pools`, `GET /fleet-ops/pools/:poolId`, and `GET /fleet-ops/overview/vehicles`.
- Formal pools use `VehicleAssetPool` and active `VehicleAssetPoolVehicle` membership.
- Direct Prisma reads are limited to scope, pool membership, safe vehicle identity filters, pagination, and counts.
- KPI/risk/economics semantics are preserved by aggregating existing Fleet Ops KPI/risk outputs rather than reimplementing those calculations from raw Prisma.
- Runtime remains read-only, GET-only, `fleet_ops:read` protected, and `FLEET_OPS_API_ENABLED` gated.

P2-H3 should implement the frontend pool overview UI:

- overview route
- pool list and pool detail routes
- GET-only API helpers
- view-model summaries
- anomaly tables
- drilldown links
- frontend read-only tests

P2-H3 implementation note:

- Routes are `/fleet-ops/overview`, `/fleet-ops/pools`, and `/fleet-ops/pools/[poolId]`.
- Existing `/fleet-ops` remains the single-vehicle diagnostic route.
- Drilldown remains `/fleet-ops?vehicleId=<id>`.
- The UI consumes only the P2-H2 GET-only backend endpoints.
- The UI must not add backend runtime changes, mutation helpers, saved custom views, batch operations, execution/write controls, or customer/public exposure.

P2-H4 should be a production trial and metric calibration phase after P2-H2/P2-H3 are validated.

### 2.6 P3 Deferred Pending P2 Effectiveness

Saved custom views should start only if P2 operators demonstrate that temporary dynamic filters are insufficient. Before P3 starts, the team must decide persistence model, ownership, sharing, audit, permission boundaries, and lifecycle semantics.

## 3. 实施

### 3.1 Product Model

#### Vehicle Pool / 车辆池

Vehicle Pool is a formal system-owned grouping.

Initial source:

- `VehicleAssetPool`
- `VehicleAssetPoolVehicle`
- active membership as the default membership rule

Future mappings:

- financing pool through financing allocation semantics
- revenue-right pool through revenue-right assignments
- management pool or system pool if a clear source of truth exists

Vehicle Pool is appropriate for official reporting, finance and asset review, risk exposure review, and recurring business reviews.

#### Dynamic Cohort / 车辆分群

Dynamic Cohort is a temporary filter-built scope. It has no persistence and no saved name. It is intended for operational analysis, anomaly discovery, and ad hoc comparison.

#### Saved Custom View / 自定义视图

Saved Custom View is deferred to P3. It is not implemented or modeled in P2-H1/H2/H3.

### 3.2 Filter Model

#### MVP Filters

- formal vehicle pool
- brand
- model
- model year
- operation state
- registration date range
- created date range
- risk level
- collection level
- D1-D5 aging bucket
- confidence band
- warning type
- evidence missing flag

#### Deferred Filters

- region beyond available `Vehicle.assetLocation`
- product plan if not cleanly mapped
- lease status if not cheap and readily available
- financing entity if not cleanly mapped
- revenue-right pool
- vehicle type taxonomy
- capital-weighted confidence

### 3.3 KPI Definitions

#### Vehicle Counts

- total
- active / operating
- idle / available
- abnormal
- overdue
- missing data / low confidence

#### Economics

- revenue
- cost
- net income
- ROI
- ROE
- denominator evidence
- low ROI vehicles

#### Cashflow

- actual operating cashflow
- actual deposit cashflow
- planned operating cashflow
- planned deposit cashflow
- unallocated cashflow

#### Deposit Treatment

- deposits shown separately
- deposits excluded from operating revenue

#### Risk / Overdue

- overdue amount
- overdue vehicle count
- overdue bill count
- max overdue days
- D1-D5 distribution
- collection priority distribution
- high-risk vehicles

#### Data Quality

- average confidence
- min confidence
- low-confidence count
- warning count
- missing evidence count
- timeline fallback count
- consistency score

#### Anomaly Lists

- highest overdue exposure
- highest risk
- lowest ROI
- lowest confidence
- missing evidence
- cashflow anomaly
- timeline fallback

### 3.4 Aggregation Rules

#### ROI / ROE

Pool and cohort ROI/ROE must not use a simple average of vehicle ROI/ROE.

Required formulas:

```text
pool ROI = total net income / total invested capital
pool ROE = total net income / total equity base
```

The response should include denominator evidence so operators can see whether ROI/ROE is reliable.

#### Revenue

Only operating revenue counts as revenue. Deposits are excluded from operating revenue and shown separately in deposit cashflow.

#### Overdue

Overdue must follow the Fleet Ops factual overdue rule:

```text
dueDate < asOfDate
AND remainingAmount > 0
AND billStatus != CANCELLED
```

The design must not rely only on `BillStatus.OVERDUE`.

#### D1-D5

```text
D1: 1-3 days
D2: 4-7 days
D3: 8-15 days
D4: 16-30 days
D5: >30 days
```

#### Confidence MVP

The MVP should expose:

- vehicle-count weighted average confidence
- minimum confidence
- confidence distribution
- low-confidence count

Capital-weighted confidence is deferred because it can hide low-quality small-vehicle evidence and requires more product review.

#### Evidence

Pool/cohort overview should summarize evidence counts and missing evidence. Full evidence details stay in the existing single-vehicle drilldown.

### 3.5 Backend Design

Potential components:

- `FleetOpsScopeResolver`
- `FleetOpsPoolAggregator`
- `FleetOpsOverviewService`
- `FleetOpsPoolReadModel` types

Rules:

- read-only
- GET-only external APIs
- `fleet_ops:read`
- `FLEET_OPS_API_ENABLED`
- no DB writes
- no execution actions
- no schema or migrations
- use Fleet Ops facade or existing Fleet Ops semantics
- direct Prisma reads allowed only for scope membership and filter resolution, not KPI/risk semantic bypass

`FleetOpsScopeResolver` should resolve vehicle IDs for:

- all permitted vehicles
- formal vehicle pool
- dynamic cohort filters

`FleetOpsPoolAggregator` should aggregate outputs from existing Fleet Ops state, timeline, KPI, and risk semantics. It should not duplicate or rewrite PR-1 to PR-5 business logic.

`FleetOpsOverviewService` should prepare the API response, including scope metadata, range metadata, KPI summaries, distributions, anomaly ranking, warnings, and pagination.

### 3.6 API Contract Proposal

Overview response should include:

- scope
- range
- generatedAt
- kpis
- cashflow
- risk
- dataQuality
- distributions
- anomalies
- pagination
- warnings
- evidence summary counts

Potential endpoints:

```text
GET /fleet-ops/overview
GET /fleet-ops/pools
GET /fleet-ops/pools/:poolId
GET /fleet-ops/vehicles
```

`GET /fleet-ops/vehicles` is optional and should be used only if the overview needs a paginated scoped vehicle/anomaly list separate from the P1-H23 identity lookup.

### 3.7 Frontend IA

Routes:

- `/fleet-ops`
- `/fleet-ops/overview`
- `/fleet-ops/pools`
- `/fleet-ops/pools/:poolId`
- `/fleet-ops?vehicleId=<id>`

Sections:

- scope selector
- filters
- KPI cards
- distributions
- anomaly tables
- drilldown links

Chinese copy:

- 车队运营总览
- 车辆池
- 车辆分群
- 单车诊断

The UI must not render write, execution, mutation, or saved-view controls in P2.

### 3.8 Performance Boundaries

- default `asOf`: server date
- default range: operational range selected by the backend/frontend contract
- max range: 366 days
- synchronous vehicle scope cap: default 300 vehicles, hard cap 500 vehicles
- anomaly top N: default 10, max 50
- vehicle lists: paginated
- vehicle list page size: max 100
- overview response: no full evidence payload
- too-large scope: return a clear limit response or summary-only fallback
- no caching or persistence in P2-H1

### 3.9 Permission / Feature Flag Boundaries

- all new Fleet Ops endpoints require `fleet_ops:read`
- all new Fleet Ops business endpoints are gated by `FLEET_OPS_API_ENABLED`
- no new Fleet Ops permission codes
- no write, execution, admin, action, allocation, or collection permissions
- no customer or public route exposure

## 4. 验证

### 4.1 Design Review Checklist

- terminology is clear
- aggregation rules are correct
- route model preserves existing `/fleet-ops` single-vehicle flow
- P3 saved custom views are deferred
- no runtime implementation is included in P2-H1
- no schema, migration, permission, seed, sync, package, CI, Docker, or deploy change is included

### 4.2 Future Automated Test Plan

Future P2-H2/P2-H3 implementation should add focused tests such as:

- `fleet-ops.pool-scope.spec.ts`
- `fleet-ops.pool-aggregation.spec.ts`
- `fleet-ops.pool-economics.spec.ts`
- `fleet-ops.pool-risk.spec.ts`
- `fleet-ops.pool-readonly.spec.ts`
- `fleet-ops-pool-overview.spec.ts`
- `fleet-ops-pool-readonly.spec.ts`
- `fleet-ops-drilldown.spec.ts`

Expected future coverage:

- scope resolver returns only intended vehicle IDs
- formal pool membership uses active pool membership semantics
- dynamic cohort filters are temporary and not persisted
- ROI/ROE are total-based
- deposits are excluded from operating revenue
- overdue facts do not rely only on `BillStatus.OVERDUE`
- overview responses do not contain full per-vehicle evidence payloads
- all new Fleet Ops routes are GET-only and read-only

### 4.3 Non-Live Verification Commands For P2-H1 Docs-Only BUILD

```bash
pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts
pnpm --filter @subscription-saas/api test:fleet-ops
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-readonly.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-view-model.spec.ts test/fleet-ops-vehicle-lookup.spec.ts
```

Do not run production commands, query production DB, run access sync, change feature flags, or deploy.

### 4.4 Future Manual Acceptance Plan

- Open overview with all permitted vehicles.
- Select a formal pool and confirm pool metrics render.
- Apply dynamic filters and confirm the scope is clearly labeled as a cohort.
- Open anomaly list rows and drill into the existing single-vehicle snapshot.
- Confirm no write, execution, mutation, or saved-view controls appear.
- Confirm disabled and permission-denied behavior follows the existing Fleet Ops pattern.

### 4.5 Safety Checklist

- no schema changes
- no migrations
- no DB writes
- no runtime implementation
- no execution endpoints
- no write permissions
- no customer/public exposure
- no saved custom view persistence
- no Fleet Ops business logic changes
- no feature flag default change
- no deployment changes
- no production commands

### 4.6 Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| performance on large vehicle sets | Use scope caps, pagination, top-N anomaly limits, and summary-only fallback. |
| misleading simple-average ROI/ROE | Require total-based aggregation and denominator evidence. |
| deposit counted as revenue | Keep deposit cashflow separate and assert deposits are excluded from operating revenue. |
| overdue definition drift | Reuse factual overdue rule based on due date, remaining amount, and non-cancelled status. |
| evidence payload too large | Return evidence counts and missing-evidence summaries at overview level; keep full evidence in drilldown. |
| confidence aggregation misleading | Show weighted average, minimum, distribution, and low-confidence count. |
| mixing formal vehicle pool with dynamic cohort | Use separate terminology, route copy, and scope metadata. |
| user confusion between pool/cohort/view | Use Chinese labels consistently: 车辆池, 车辆分群, 自定义视图. |
| P3 saved view write-scope creep | Keep saved custom views out of P2-H1/H2/H3 and require separate P3 governance. |
| EOL/worktree pollution | Keep P2-H1 docs-only, stage explicit files only, and run diff/EOL checks before commit. |
