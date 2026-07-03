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
