\# Fleet Ops OS Planning Docs



This directory contains the architecture source, current review conclusion, and next-stage Codex construction specs for Fleet Ops OS.



\- source/plan\_design.md: Plan A architecture design

\- source/code\_review\_202607011626.md: Current code review conclusion

\- next-stage/dev\_spec.md: Development specification

\- next-stage/agents.md: Agent responsibilities and construction discipline

\- next-stage/codex\_tasks.md: Codex task backlog and prompts

\- docs/fleet-ops/next-stage/codex_workflow_rules.md: Codex branch, build, verify, recovery, and local commit governance rules

\- next-stage/p2_pool_overview_design.md: P2-H1 pool overview and dynamic cohort design. It moves Fleet Ops from single-vehicle diagnostic toward pool/cohort overview, anomaly ranking, vehicle list, and single-vehicle drilldown while keeping P3 saved custom views deferred pending P2 effectiveness.

\- runbooks/staging-smoke.md: P1-H11 staging enablement and smoke runbook for the read-only Fleet Ops API/UI after P1-H10.1 or newer. Use it to enable `FLEET_OPS_API_ENABLED=true`, run the existing access sync command when an existing DB lacks Fleet Ops access, verify ADMIN / OP / GM access, and confirm Fleet Ops remains read-only.

\- runbooks/production-readiness.md: P1-H14 production readiness checklist for a later controlled production enablement decision after successful P1-H13 smoke evidence. Production enablement is not automatic; `FLEET_OPS_API_ENABLED` remains operator-controlled, and Fleet Ops remains read-only.

\- runbooks/production-go-no-go-record.md: P1-H15 production GO / NO-GO decision record to complete after the production readiness checklist. The record defaults to `PENDING`, does not enable production by itself, and keeps Fleet Ops read-only.

\- runbooks/production-image-alignment.md: P1-H18 production API/Web image alignment runbook to use before production access sync and feature flag enablement. It keeps `FLEET_OPS_API_ENABLED=false` during image rollout and separates image alignment from Fleet Ops enablement.

\- runbooks/production-enablement-record-20260705.md: P1-H22 production enablement record. It records the operator-completed production enablement outcome with conclusion `PASS_WITH_NOTES` and tracks follow-up P1-H23 vehicle selector/lookup work.

## P1-H23 Vehicle Lookup / Drilldown Entry

P1-H23 adds a read-only Fleet Ops vehicle lookup entry for `/fleet-ops`.

- Users may search by internal vehicle ID, vehicle number, VIN, or license plate.
- Lookup responses are minimal and masked: VIN suffix only and masked plate only.
- Selecting a result loads the existing single-vehicle Fleet Ops snapshot.
- `/fleet-ops?vehicleId=<id>` opens the same single-vehicle snapshot.
- Fleet Ops remains read-only: no execution/write buttons, no new permissions beyond `fleet_ops:read`, and no customer/public exposure.
- P2 pool overview / dynamic cohort views remain next-stage work.
- P3 saved custom views remain deferred pending P2 effectiveness.

## P2-H1 Pool Overview / Dynamic Cohort Design

P2-H1 is documented in `docs/fleet-ops/next-stage/p2_pool_overview_design.md`.

- P2 moves Fleet Ops from single-vehicle diagnostic toward pool/cohort overview, anomaly ranking, vehicle list, and single-vehicle snapshot drilldown.
- The design distinguishes formal `车辆池 / Vehicle Pool`, temporary `车辆分群 / Dynamic Cohort`, and P3-only `自定义视图 / Saved Custom View`.
- The first P2 implementation phases must remain read-only, keep `fleet_ops:read`, respect `FLEET_OPS_API_ENABLED`, and avoid execution/write controls.
- P3 saved custom views remain deferred pending P2 effectiveness because they require write scope, ownership, audit, permission, and persistence design.

## P2-H2 Pool Overview Backend

P2-H2 adds the backend read-only aggregation surface for future pool/cohort UI work.

- MVP endpoints: `GET /fleet-ops/overview`, `GET /fleet-ops/pools`, `GET /fleet-ops/pools/:poolId`, and `GET /fleet-ops/overview/vehicles`.
- Formal pool source: `VehicleAssetPool` plus active `VehicleAssetPoolVehicle` membership.
- Dynamic cohort MVP filters: pool, brand, model, model year, vehicle status, registration date range, created date range, and asset location.
- Performance caps: scope default 300, hard scope cap 500, `topN` default 10/max 50, page size max 100, date range max 366 days.
- Aggregation reuses existing Fleet Ops KPI/risk services; direct Prisma reads are limited to scope, pool membership, and safe vehicle identity filters.
- P2-H2 remains GET-only, requires `fleet_ops:read`, respects `FLEET_OPS_API_ENABLED`, adds no schema/migration/write path, and does not implement Web UI or saved custom views.
