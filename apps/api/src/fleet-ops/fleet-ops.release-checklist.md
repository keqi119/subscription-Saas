# Fleet Ops OS v1 Release Checklist

Use this checklist before promoting Fleet Ops OS v1 beyond local development.

## Scope

Fleet Ops OS v1 includes PR-1 through PR-10:

- PR-1 state engine
- PR-2 timeline engine
- PR-3 economics engine
- PR-4 risk / control engine
- PR-5 guarded execution engine
- PR-6 optimization advisory engine
- PR-7 governance policy proposal engine
- PR-8 coordination engine
- PR-9 module / facade / health / invariants
- PR-10 release readiness / observability / smoke diagnostics

PR-10 does not add a new intelligence layer and does not add a new execution path.

## Docs traceability

Confirm the Fleet Ops runtime docs remain linked to the repository-local source-of-truth docs:

- `docs/fleet-ops/source/plan_design.md`
- `docs/fleet-ops/source/code_review_202607011626.md`
- `docs/fleet-ops/next-stage/dev_spec.md`
- `docs/fleet-ops/next-stage/agents.md`
- `docs/fleet-ops/next-stage/codex_tasks.md`
- `docs/fleet-ops/README.md`

## Canonical Release Candidate Gate

Run the Fleet Ops release candidate gate before promotion or before marking a Fleet Ops hardening branch ready.

Run typecheck:

```bash
pnpm --filter @subscription-saas/api typecheck
```

Run lint:

```bash
pnpm --filter @subscription-saas/api lint
```

Run the focused Fleet Ops regression gate:

```bash
pnpm --filter @subscription-saas/api test:fleet-ops
```

The `test:fleet-ops` script is the canonical focused gate. It covers vehicle operational state, vehicle timeline, Fleet Ops economics/KPI, risk/collection, convergence/facade, E2E/smoke, invariants, read-only, boundary, no-schema, health, and facade-contract tests through direct focused test targets in `apps/api/package.json`.

For controlled read-only API exposure, the same gate must include:

- `test/fleet-ops.controller.spec.ts`
- `test/fleet-ops.api-contract.spec.ts`
- `test/fleet-ops.api-readonly.spec.ts`
- `test/fleet-ops.api-feature-gate.spec.ts`

Confirm the API remains disabled by default through `FLEET_OPS_API_ENABLED`, guarded by `fleet_ops:read`, GET-only, and facade-only for business data.

Do not use this command as the release candidate gate:

```bash
pnpm --filter @subscription-saas/api test -- fleet-ops
```

Package test argument narrowing has been unreliable in this repository and can run an unintended test set.

Run the read-only safety scan:

```bash
rg -n -g '*.ts' -g '*.tsx' '\.create\(|\.update\(|\.delete\(|\.upsert\(|\.createMany\(|\.updateMany\(|\.deleteMany\(|\$executeRaw|\$queryRawUnsafe|\$transaction|save\(|persist\(|mutate\(|setStatus\(|updateStatus\(|auditSink\??\.write\(|auditLog|writeAudit' apps/api/src/fleet-ops
```

Expected result: no matches. `rg` exit code `1` is acceptable for no matches.

Run the safety diff checks:

```bash
git status --short --branch --untracked-files=all
git diff --name-status
git diff --stat
git diff --ignore-space-at-eol --stat
git diff --check
git diff -- apps/api/prisma/schema.prisma
git diff -- apps/api/prisma/migrations
git diff -- prisma/schema.prisma
git diff -- prisma/migrations
git diff -- apps/api/src/app.module.ts
```

Expected result: clean scope, no whitespace errors, no EOL churn, no schema diff, no migration diff, and no AppModule diff.

Codex may create local commits for approved Fleet Ops tasks only. Push, pull request creation, merge, and release promotion remain human-owned remote actions.

## Bootstrap Smoke Check

The release smoke suite must verify:

- `AppModule` compiles with `FleetOpsModule` mounted.
- `FleetOpsFacade` is injectable.
- `FleetOpsHealthService` is injectable.
- No provider constructor performs Prisma delegate calls during bootstrap.

## Controlled API Exposure Readiness

Before enabling `FLEET_OPS_API_ENABLED` outside local development, confirm:

- Only `/fleet-ops` GET endpoints are registered.
- Health may return `enabled:false` while business and diagnostics endpoints are blocked when disabled.
- Business data endpoints call only the root Nest `FleetOpsFacade`.
- The controller does not inject lower-layer Fleet Ops services, PR-5 execution services, Prisma, Finance, Payment, Report, or Order services.
- No execution action, allocation, lease activation, collection action, POST, PATCH, PUT, DELETE, public portal, or customer-facing endpoint is exposed.
- Response envelopes include `generatedAt` and optional `requestId`, `traceId`, and `warnings`.
- Timeline/economics/risk range requests enforce the 366-day maximum.

## P1-H6 Contract Smoke Readiness

P1-H6 adds no runtime behavior and must not modify PR-1 to PR-5 logic. It only hardens tests and readiness documentation for the state -> timeline -> economics -> risk -> convergence snapshot contract.

The P1-H6 smoke suite must verify:

- `FleetOpsFacade.query(vehicleId)` preserves PR-1 state, PR-2 timeline, PR-3 economics, and PR-4 risk outputs in `FleetOpsSnapshot`.
- Evidence remains source-distinguishable across lease, vehicle, payment, deposit, receivable bill, collection case, collection action, and write-off signals.
- Warnings and confidence penalties propagate for current-status timeline fallback, economics warnings, and risk warnings.
- Deposit cashflow is visible separately from operating revenue.
- Overdue exposure uses remaining amount and keeps D1-D5 aging bucket plus arrears pipeline evidence.
- Conflicts are flagged and surfaced as consistency diagnostics without being resolved.
- No smoke test relies on live DB fixtures or calls PR-5 execution actions.

Codex may create local commits for approved Fleet Ops tasks only. Push, pull request creation, merge, and release promotion remain human-owned remote actions.

## P1-H9 Admin UI Read-Only Check

P1-H9 adds the direct admin route `/fleet-ops` in the web app only. It does not add shared menu entries, seed permissions, backend runtime behavior, schema changes, or write paths.

Before release, confirm:

- `FLEET_OPS_API_ENABLED` is enabled only for intended internal/admin environments.
- The current admin account has `fleet_ops:read`.
- `/fleet-ops` shows health, disabled, permission-denied, empty, and error states cleanly.
- Snapshot panels remain read-only and display state, timeline warnings, economics cashflow/deposit/ROI/ROE, risk exposure/D1-D5/arrears pipeline, evidence, warnings, confidence, and consistency diagnostics.
- No execution, mutation, customer portal, shared menu, seed, or shared permission provisioning change is included in the UI PR.

Focused web checks:

```bash
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-api.spec.ts test/fleet-ops-view-model.spec.ts test/fleet-ops-readonly.spec.ts
pnpm --filter @subscription-saas/api test:fleet-ops
```

`apps/web/test/fleet-ops-readonly.spec.ts` is a long-lived UI/client source-state safety guard. It verifies the Fleet Ops frontend stays GET-only, does not expose execution or mutation controls, does not add customer/public portal Fleet Ops routes, and does not introduce forbidden Fleet Ops write/execute/admin/action permissions in shared or provisioning sources. It must not require specific PR diff files, so docs-only Fleet Ops PRs should pass the guard.

## P1-H10 Menu And Permission Provisioning Check

P1-H10 makes the existing read-only admin UI discoverable through the shared menu and seed baseline. It must not change Fleet Ops API, facade, controller, PR-1 to PR-5 logic, schema, migrations, AppModule, or write flows.

Before release, confirm:

- Shared permission includes only `fleet_ops:read` for Fleet Ops.
- Shared menu includes `vehicles.fleet_ops` with Chinese label `车队运营`, path `/fleet-ops`, and permission `fleet_ops:read`.
- Seed includes the Fleet Ops read permission and menu row.
- ADMIN receives access through existing all-access seed behavior.
- OP and GM receive explicit internal/admin read access.
- SA, RC, FI, AS, CS, customer-like, and public roles are not granted Fleet Ops access in this PR.
- No Fleet Ops write, execute, admin, action, allocate, or collect permission exists.
- No execution submenu, mutation menu, customer portal menu, or public route is introduced.
- `FLEET_OPS_API_ENABLED` still controls API availability; the UI may show disabled state while the menu is visible.

Focused provisioning checks:

```bash
pnpm --filter @subscription-saas/shared typecheck
pnpm --filter @subscription-saas/shared lint
pnpm --filter @subscription-saas/shared exec vitest run test/auth.spec.ts test/menus.spec.ts
pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-readonly.spec.ts test/fleet-ops-view-model.spec.ts
```

## P1-H10.1 Existing DB Access Sync

P1-H10.1 repairs existing local or staging databases that were seeded before the Fleet Ops read permission and menu existed. Use it when an admin account still sees `无权访问` on `/fleet-ops` or the sidebar does not show `车队运营` after P1-H10 is merged.

Run the narrow idempotent sync command:

```bash
pnpm --filter @subscription-saas/api prisma:sync:fleet-ops-access
```

The command must only upsert:

- Permission: `fleet_ops:read` / `车队运营查看`.
- Menu: `vehicles.fleet_ops` / `车队运营` / `/fleet-ops`.
- Role links for `ADMIN`, `OP`, and `GM`.

It must not run the full seed, add migrations, change schema, add runtime DB writes, add Fleet Ops write/execute/admin/action permissions, create execution submenus, or grant customer/public portal access.

After the command runs, log out and log in again so `/auth/me` reloads DB-backed role permissions and menus. Verify `/auth/me` includes `fleet_ops:read`, `/auth/me` menus include `/fleet-ops`, the sidebar shows `车队运营`, and `/fleet-ops` no longer shows the permission-denied state for the intended admin user. If `FLEET_OPS_API_ENABLED` is off, the page may still show the expected API disabled state.

## P1-H11 Staging Smoke Check

Use `docs/fleet-ops/runbooks/staging-smoke.md` before enabling Fleet Ops for staging operators.

Before release or staging validation, confirm:

- API and Web are deployed from the same P1-H10.1-or-newer commit family.
- Run `pnpm --filter @subscription-saas/api prisma:sync:fleet-ops-access` only if `/system/permissions`, `/auth/me`, or the sidebar is missing Fleet Ops access.
- `FLEET_OPS_API_ENABLED=true` is set for staging API enablement.
- `/system/permissions` shows `车队运营查看 / fleet_ops:read`.
- `/auth/me` permissions include `fleet_ops:read`.
- `/auth/me` menus include `/fleet-ops` or `vehicles.fleet_ops`.
- Sidebar shows `车队运营`.
- `/fleet-ops` opens for ADMIN, OP, and GM.
- A non-granted role is denied or does not see the Fleet Ops menu.
- `/fleet-ops` shows disabled, permission-denied, empty vehicle, and valid vehicle smoke states as applicable.
- No execution, write, mutation, customer portal, or public Fleet Ops controls are exposed.
- Rollback is `FLEET_OPS_API_ENABLED=false` followed by restart/redeploy as needed; no schema rollback is required.

## P1-H14 Production Readiness Check

Use `docs/fleet-ops/runbooks/production-readiness.md` before any controlled production enablement decision. P1-H14 is documentation and checklist only; it must not enable production or change Fleet Ops runtime behavior.

Before production go/no-go, confirm:

- P1-H13 staging smoke evidence is captured.
- Mandatory automated gates are current:
  - `pnpm --filter @subscription-saas/api test:fleet-ops`
  - `pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts`
  - `pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-readonly.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-view-model.spec.ts`
- Production DB target is confirmed before any access sync command is run.
- Codex automated verification does not run live DB sync.
- `FLEET_OPS_API_ENABLED` remains disabled in production until an approved GO decision.
- Production smoke checks verify `fleet_ops:read`, `/fleet-ops`, sidebar `车队运营`, ADMIN / OP / GM access according to policy, non-granted role denial, API health, valid vehicle snapshot, evidence/warnings/confidence, and no execution/write controls.
- Rollback is `FLEET_OPS_API_ENABLED=false` followed by restart/redeploy as needed; permission/menu entries may remain and no schema or data rollback is required.

## P1-H15 Production GO / NO-GO Record

Use `docs/fleet-ops/runbooks/production-go-no-go-record.md` to capture the human production decision after P1-H13 smoke evidence and P1-H14 production readiness review.

Before marking anything other than `PENDING`, confirm:

- The record defaults to `PENDING` and does not enable production by itself.
- P1-H13 and P1-H14 evidence is linked or captured.
- Mandatory automated gates are current.
- Owner sign-offs are captured for product/operations, engineering, data/DB, security/permission, feature flag, rollback, and communication.
- Production DB target is confirmed before any access sync command is run.
- Feature flag owner and rollback owner are identified.
- Codex automated verification does not run live DB sync.
- This PR does not enable production, change `FLEET_OPS_API_ENABLED` defaults, or modify Fleet Ops runtime behavior.
- No execution/write controls, permissions, customer/public exposure, schema changes, migrations, seed changes, sync script changes, or package script changes are introduced.

## P1-H16 Production Decision Record Completion

Use P1-H16 only to complete the production decision record baseline with known P1-H13 local/staging evidence. Completion of this baseline must not be treated as production approval.

Before committing a P1-H16 update, confirm:

- The production go/no-go record still shows final decision status `PENDING`.
- Known P1-H13 local/staging evidence may be filled into the record.
- Production-specific fields remain `TBD - human required` unless explicit human production evidence is provided.
- Production DB target, production API/Web commits, selected production vehicleId, feature flag owner, rollback owner, decision owner, communication owner, access policy approval, planned enable time, observation window, and production smoke evidence remain human-owned fields.
- Codex automated verification does not run live DB sync.
- This PR does not enable production or change `FLEET_OPS_API_ENABLED` defaults.
- No production feature flag enablement, runtime behavior change, permission model change, seed/sync behavior change, schema change, migration, execution/write permission, or customer/public exposure is introduced.

## P1-H17 Production Decision Finalization

Use P1-H17 only to record an explicit human GO decision in `docs/fleet-ops/runbooks/production-go-no-go-record.md`. Recording GO approves controlled read-only production readiness; it does not enable production by itself.

Before committing a P1-H17 update, confirm:

- GO is recorded only from explicit human decision input.
- Production access sync and feature flag changes remain operator-controlled.
- If the planned enable time is already elapsed, it is clearly marked for human re-confirmation before enablement.
- Codex automated verification does not run live DB sync.
- Codex does not query the production database.
- This PR does not enable production or change `FLEET_OPS_API_ENABLED` defaults.
- No production feature flag enablement, runtime behavior change, permission model change, seed/sync behavior change, schema change, migration, execution/write permission, or customer/public exposure is introduced.

## P1-H18 Production Image Alignment

Use `docs/fleet-ops/runbooks/production-image-alignment.md` to align production API/Web images before any Fleet Ops production enablement.

Before production access sync or feature flag enablement, confirm:

- Current production API/Web images are not aligned and must not be used for Fleet Ops enablement.
- Target commit and image tags are captured.
- API and Web images come from the same commit family.
- Migration/preflight is completed or explicitly resolved by the operator.
- `FLEET_OPS_API_ENABLED=false` remains in place during image alignment.
- Access sync is not run during image alignment.
- Rollback API/Web image pair is captured.
- Post-alignment smoke passes before any Fleet Ops enablement step.
- Image alignment does not change runtime behavior, API behavior, UI behavior, permission model, seed/sync behavior, package scripts, CI, Dockerfiles, compose files, schema, or migrations.

## P1-H22 Production Enablement Record

Use `docs/fleet-ops/runbooks/production-enablement-record-20260705.md` to record the operator-completed production enablement outcome.

Recorded outcome:

- Conclusion: `PASS_WITH_NOTES`.
- Feature flag enabled by operator: `FLEET_OPS_API_ENABLED=true`.
- Fleet Ops access sync completed for permission `fleet_ops:read`, menu `vehicles.fleet_ops` / `/fleet-ops`, and roles `OP`, `GM`, and `ADMIN`.
- API/Web production images aligned to `prod-20260704-d444f59`.
- Migration status recorded as up to date.
- API health after enablement recorded as 200 OK.
- Fleet Ops production UI smoke generated a vehicle snapshot for selected vehicleId `5e354d25-41ce-4432-9fc5-ea70e49a1b40`.
- Snapshot rendered state, timeline, economics, risk, warnings, confidence, consistency, and evidence groups.
- No execution/write controls were reported.
- `EXECUTION_GUARD` appeared as diagnostic evidence only, not as an action control.

Remaining notes:

- Selected vehicle has sparse operational/economic history, so LOW confidence and timeline fallback warning are expected.
- OP / GM access smoke still needs explicit production confirmation if not yet tested.
- Non-granted role denial still needs explicit production confirmation if not yet tested.
- Current UI requires manual vehicleId input.
- Follow-up P1-H23 should implement Fleet Ops vehicle selector/lookup.

## P1-H23 Vehicle Lookup / Drilldown Entry

P1-H23 makes the read-only `/fleet-ops` surface usable without manually discovering an internal vehicle ID.

Before release, confirm:

- `/fleet-ops` supports lookup by internal vehicle ID, vehicle number, VIN, and license plate.
- Lookup responses include only minimal safe identity fields.
- VIN is returned as suffix only, and plate is masked.
- Selecting a lookup result loads the existing single-vehicle snapshot.
- `/fleet-ops?vehicleId=<id>` loads the same single-vehicle snapshot.
- `fleet_ops:read` remains the only Fleet Ops permission required.
- `FLEET_OPS_API_ENABLED` gates the lookup endpoint with the other Fleet Ops business endpoints.
- No customer, finance, lease, payment, full VIN, full plate, or sensitive evidence payload is returned by lookup.
- No Fleet Ops write/execution endpoints, mutation controls, saved custom views, customer/public exposure, schema changes, migrations, seed/sync changes, AppModule changes, package script changes beyond the focused Fleet Ops test list, CI, Dockerfile, or compose changes are introduced.
- P2 pool overview / dynamic cohort remains out of scope.
- P3 saved custom views remain deferred pending P2 effectiveness.

Focused checks:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/fleet-ops.vehicle-lookup.spec.ts test/fleet-ops.api-readonly.spec.ts test/fleet-ops.boundary.spec.ts test/fleet-ops.controller.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-vehicle-lookup.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-readonly.spec.ts test/fleet-ops-view-model.spec.ts
```

## P2-H1 Pool Overview / Dynamic Cohort Design

Use `docs/fleet-ops/next-stage/p2_pool_overview_design.md` as the P2-H1 design source for pool overview and dynamic cohort work.

P2-H1 does not alter runtime behavior. It does not change Fleet Ops API/controller/facade/module logic, Fleet Ops UI behavior, schema, migrations, seed behavior, sync behavior, permission model, package scripts, CI, Dockerfiles, compose files, or deployment configuration.

Before starting P2-H2 or P2-H3 implementation, confirm:

- Pool overview and dynamic cohort work remains read-only.
- New Fleet Ops business endpoints remain GET-only.
- `fleet_ops:read` remains the only Fleet Ops permission required.
- `FLEET_OPS_API_ENABLED` gates the new Fleet Ops business endpoints.
- No execution, write, admin, action, allocation, or collection permission is added.
- No execution, mutation, customer portal, public route, or saved-view control is exposed.
- No saved custom view persistence is added in P2-H2 or P2-H3.
- KPI aggregation preserves total-based ROI/ROE and does not use a simple average of vehicle ROI/ROE.
- Deposits remain separate from operating revenue.
- Overdue detection keeps using factual overdue semantics instead of relying only on `BillStatus.OVERDUE`.

Focused P2-H1 docs-only checks:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts
pnpm --filter @subscription-saas/api test:fleet-ops
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-readonly.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-view-model.spec.ts test/fleet-ops-vehicle-lookup.spec.ts
```

## P2-H2 Pool Overview Backend Check

P2-H2 adds backend-only read-only aggregation for pool overview and dynamic cohorts.

Before release or frontend integration, confirm:

- `GET /fleet-ops/overview`, `GET /fleet-ops/pools`, `GET /fleet-ops/pools/:poolId`, and `GET /fleet-ops/overview/vehicles` are the only new Fleet Ops pool/cohort endpoints.
- All new endpoints are GET-only, guarded by `fleet_ops:read`, and gated by `FLEET_OPS_API_ENABLED`.
- Formal pools use `VehicleAssetPool` and active `VehicleAssetPoolVehicle` membership.
- Dynamic cohort MVP filters are pool, brand, model, model year, vehicle status, registration date range, created date range, and asset location.
- Scope caps remain default 300 and hard max 500; `topN` remains default 10/max 50; page size max remains 100; date range max remains 366 days.
- Direct Prisma reads are limited to scope, pool membership, safe vehicle identity filters, pagination, and counts.
- KPI/risk/economics semantics remain in the existing Fleet Ops KPI/risk services or approved summaries.
- ROI/ROE remain total-based, deposits remain separate from operating revenue, and overdue/D1-D5 semantics preserve the existing Fleet Ops risk rules.
- Overview/list responses do not include full evidence payloads.
- No schema, migration, seed, sync, permission, AppModule, Web runtime, write endpoint, execution endpoint, saved custom view, customer/public exposure, CI, Docker, compose, or deployment change is introduced.

Focused P2-H2 checks:

```bash
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/api test:fleet-ops
pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts test/fleet-ops.pool-scope.spec.ts test/fleet-ops.pool-aggregation.spec.ts test/fleet-ops.pool-economics.spec.ts test/fleet-ops.pool-risk.spec.ts test/fleet-ops.pool-readonly.spec.ts test/fleet-ops.api-contract.spec.ts test/fleet-ops.api-readonly.spec.ts test/fleet-ops.boundary.spec.ts test/fleet-ops.controller.spec.ts
```

## P2-H3 Pool Overview Frontend UI Check

P2-H3 adds frontend-only read-only pool overview UI.

Before release or production smoke, confirm:

- `/fleet-ops/overview`, `/fleet-ops/pools`, and `/fleet-ops/pools/[poolId]` are available.
- Existing `/fleet-ops` remains the single-vehicle diagnostic page.
- Drilldown remains `/fleet-ops?vehicleId=<id>`.
- The UI consumes only the P2-H2 GET-only backend endpoints.
- The UI remains read-only and preserves `fleet_ops:read`, `FLEET_OPS_API_ENABLED`, disabled-state handling, and permission denied handling.
- No schema, migration, seed, sync, permission, backend runtime, package script, saved custom view, batch operation, execution/write control, customer/public exposure, CI, Docker, compose, or deployment change is introduced.
- P2-H4 production smoke and metric calibration remain next.
- P3 saved custom views remain deferred pending P2 effectiveness.

Focused P2-H3 checks:

```bash
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-pool-api.spec.ts test/fleet-ops-pool-view-model.spec.ts test/fleet-ops-pool-overview.spec.ts test/fleet-ops-pool-readonly.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-readonly.spec.ts test/fleet-ops-view-model.spec.ts test/fleet-ops-vehicle-lookup.spec.ts
pnpm --filter @subscription-saas/api test:fleet-ops
```

## P2-H4 Pool Overview Smoke And Metric Calibration Check

P2-H4 adds docs/runbook coverage for post-deployment smoke and metric calibration.

Before accepting P2 pool overview in staging or production, confirm:

- `docs/fleet-ops/runbooks/p2-pool-overview-smoke.md` exists and is followed by the operator.
- `docs/fleet-ops/runbooks/p2-pool-overview-calibration-record.md` is completed with redacted evidence.
- API smoke covers `GET /fleet-ops/health`, `GET /fleet-ops/overview`, `GET /fleet-ops/pools`, `GET /fleet-ops/pools/:poolId`, `GET /fleet-ops/overview/vehicles`, and `GET /fleet-ops/vehicles/lookup`.
- Web smoke covers `/fleet-ops`, `/fleet-ops?vehicleId=<id>`, `/fleet-ops/overview`, `/fleet-ops/pools`, and `/fleet-ops/pools/[poolId]`.
- Role smoke covers `ADMIN`, `OP`, `GM`, a non-granted internal role when available, and customer/public non-exposure.
- Feature flag smoke confirms `FLEET_OPS_API_ENABLED` behavior without Codex changing production flags.
- Read-only smoke confirms no saved custom view, batch operation, execution/write, collection, pool mutation, or vehicle assignment controls.
- Metric calibration samples at least one formal active pool and one dynamic cohort when data exists.
- KPI calibration checks vehicle counts, economics, cashflow, ROI/ROE, deposit exclusion, overdue amount, overdue counts, D1-D5 distribution, confidence, warnings, and evidence summary behavior.
- Anomaly validation checks highest overdue exposure, highest risk, lowest ROI, lowest confidence, missing evidence, cashflow anomaly, and timeline fallback lists.
- Drilldown remains passive and opens `/fleet-ops?vehicleId=<id>`.
- Rollback/disable guidance remains operator-only, with `FLEET_OPS_API_ENABLED=false` as the first disable path when appropriate.
- P2-H5 owns post-smoke correction or production hardening if evidence shows gaps.
- P3 saved custom views remain deferred pending P2 effectiveness.

Focused P2-H4 checks:

```bash
pnpm --filter @subscription-saas/api test:fleet-ops
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-pool-api.spec.ts test/fleet-ops-pool-view-model.spec.ts test/fleet-ops-pool-overview.spec.ts test/fleet-ops-pool-readonly.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-readonly.spec.ts test/fleet-ops-view-model.spec.ts test/fleet-ops-vehicle-lookup.spec.ts
pnpm --filter @subscription-saas/api exec vitest run test/fleet-ops.api-contract.spec.ts test/fleet-ops.pool-aggregation.spec.ts test/fleet-ops.pool-readonly.spec.ts
```

Production smoke record:

- Record path: `docs/fleet-ops/runbooks/p2-pool-overview-calibration-record-20260705.md`.
- Final classification: `PASS_WITH_NOTES`.
- Production images: `prod-20260705-aa8dc89` API/Web.
- `FLEET_OPS_API_ENABLED=true`.
- Core routes, role access, read-only safety, metric semantics, and anomaly drilldown were operator-smoked.
- No rollback or feature disable was required.
- P2-H5 should be evidence-based after passive observation.
- P3 saved custom views remain deferred pending P2 effectiveness.

## P2-H5 Production Closeout Check

P2-H5 records the production hardening and closeout decision after P2-H4 smoke.

Before accepting P2 closeout, confirm:

- `docs/fleet-ops/runbooks/p2-production-closeout-20260705.md` exists.
- P2-H4 production smoke evidence was reviewed.
- Final closeout classification remains `PASS_WITH_NOTES`.
- No rollback or feature disable is required.
- Runtime hardening is not required immediately.
- P2-H6 trigger criteria are documented.
- P3 saved custom views remain deferred.

Focused P2-H5 checks:

```bash
pnpm --filter @subscription-saas/api test:fleet-ops
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-pool-api.spec.ts test/fleet-ops-pool-view-model.spec.ts test/fleet-ops-pool-overview.spec.ts test/fleet-ops-pool-readonly.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-readonly.spec.ts test/fleet-ops-view-model.spec.ts test/fleet-ops-vehicle-lookup.spec.ts
pnpm --filter @subscription-saas/api exec vitest run test/fleet-ops.api-contract.spec.ts test/fleet-ops.pool-aggregation.spec.ts test/fleet-ops.pool-readonly.spec.ts
```

## Known Baseline Issue

The broader API test script can expose this unrelated existing failure:

```text
test/order-delivery.spec.ts / canPrepareDelivery
```

This is not introduced by Fleet Ops PR-10. Do not modify order delivery behavior in the Fleet Ops release PR. Track or fix it separately.

## Readiness Expectations

- `FleetOpsHealthService` must return every engine status as `OK`, `WARN`, or `ERROR`.
- `FleetOpsFacade` must remain the stable external integration surface.
- PR-6, PR-7, and PR-8 outputs are advisory only.
- PR-5 execution remains guarded by PR-4 snapshots.
- Facade and health calls must not write audit logs.
- Optional dependencies must degrade safely and must not change core decision behavior.

## Rollback Strategy

- Remove `FleetOpsModule` from `AppModule` imports to disable subsystem loading.
- Keep PR-1 to PR-10 files available for investigation because they are read-only or advisory except guarded PR-5 execution.
- Re-run typecheck, lint, schema diff, and app bootstrap after rollback.

## Production Monitoring Expectations

- Track facade operation latency with `traceId`, `requestId`, `engineName`, and `operationName`.
- Surface health degradation per engine.
- Alert on read-only invariant failures.
- Alert if PR-6, PR-7, or PR-8 attempts to execute actions.
- Audit PR-5 execution logs only for explicit execution requests.
