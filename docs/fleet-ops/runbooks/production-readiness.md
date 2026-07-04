# Fleet Ops Production Readiness Checklist

## Purpose And Scope

Use this checklist to decide whether the read-only Fleet Ops API and admin UI are ready for a later controlled production enablement.

This checklist does not enable production. It does not change feature flag defaults, permissions, seed data, sync behavior, schema, migrations, API logic, UI behavior, or production data.

Fleet Ops production readiness is limited to:

- Read-only API and admin UI exposure.
- Existing `fleet_ops:read` permission and `/fleet-ops` menu access.
- Operator-controlled feature flag enablement.
- Smoke validation, evidence capture, go/no-go review, and rollback readiness.

Fleet Ops production readiness explicitly excludes:

- Execution or write actions.
- Fleet Ops write, execute, admin, action, allocate, or collect permissions.
- Customer/public portal exposure.
- Production data mutation by Fleet Ops.
- Schema or migration changes.

## Preconditions

Confirm these before any production go/no-go meeting:

| Item | Expected |
| --- | --- |
| P1-H13 staging smoke | Completed and evidence captured. |
| Code baseline | Latest main includes P1-H12 or newer. |
| API/Web alignment | API and Web are deployed from the same commit family. |
| Production image alignment | `docs/fleet-ops/runbooks/production-image-alignment.md` is completed before Fleet Ops enablement. |
| Production DB target | Confirmed before any access sync command is run. |
| Backup and rollback policy | Production backup, restore, and application rollback owners understand the existing production runbooks. |
| Access policy | ADMIN / OP / GM production Fleet Ops read access is approved. |
| Smoke vehicle | A known safe `vehicleId` or anonymized production test vehicle is identified. |
| Public exposure | No customer/public Fleet Ops exposure is expected. |
| Production flag | `FLEET_OPS_API_ENABLED` remains disabled until a GO decision approves enablement. |

## P1-H13 Staging Smoke Evidence Baseline

P1-H13 staging or local-staging evidence should be available before production go/no-go.

Known evidence categories:

| Evidence | Expected status |
| --- | --- |
| Web focused Fleet Ops tests | `fleet-ops-readonly`, `fleet-ops-api`, and `fleet-ops-view-model` passed. |
| Access sync | Completed for OP / GM / ADMIN in staging or local-staging. |
| API Fleet Ops RC gate | `pnpm --filter @subscription-saas/api test:fleet-ops` passed. |
| API permission test | `pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts` passed. |
| API service status | Fleet Ops API service reported available. |
| Permission and menu checks | `fleet_ops:read`, `/fleet-ops`, and `车队运营` were visible for intended roles. |
| UI permission state | `/fleet-ops` no longer showed permission denied for authorized ADMIN access. |

Record links or screenshots for the actual P1-H13 evidence packet in the production go/no-go notes.

After this checklist is complete, record the human production decision in `docs/fleet-ops/runbooks/production-go-no-go-record.md`. That record defaults to `PENDING`; production enablement remains human/operator-controlled.

## Mandatory Automated Gates

Run these non-live gates before production enablement:

```bash
pnpm --filter @subscription-saas/api test:fleet-ops
pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-readonly.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-view-model.spec.ts
```

Optional but recommended:

```bash
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/shared typecheck
pnpm --filter @subscription-saas/shared lint
```

Do not run broad production data sync, full seed, or live DB mutation commands as automated verification for this checklist.

## Production Image Alignment Gate

Before production access sync or feature flag enablement, complete:

```text
docs/fleet-ops/runbooks/production-image-alignment.md
```

Image alignment requirements:

- API and Web images must be aligned to the same approved main commit family.
- Migration/preflight must be resolved before image rollout.
- `FLEET_OPS_API_ENABLED=false` must remain in place during image alignment.
- Production image alignment is not Fleet Ops feature enablement.
- Access sync and setting `FLEET_OPS_API_ENABLED=true` remain later operator actions.

## Production Access Sync Readiness

Use the existing Fleet Ops access sync command only if production DB permissions or menus are missing after deployment:

```bash
pnpm --filter @subscription-saas/api prisma:sync:fleet-ops-access
```

Production sync rules:

- Authorized operator only.
- Confirm the production `DATABASE_URL` target before running.
- Idempotent and safe to rerun for Fleet Ops access provisioning.
- Affects only Fleet Ops read permission, menu, and role links.
- Roles: `ADMIN`, `OP`, and `GM`.
- Requires logout/login after sync so `/auth/me` refreshes DB-backed permissions and menus.
- Does not run full seed.
- Does not change schema.
- Does not add migrations.
- Does not add write, execute, admin, action, allocate, or collect permissions.
- Must not be run by Codex automated verification.

## Feature Flag Policy

Production default should remain disabled unless a go decision explicitly approves enablement.

Enablement key:

```text
FLEET_OPS_API_ENABLED=true
```

Rollback key:

```text
FLEET_OPS_API_ENABLED=false
```

Expected behavior:

- When false or absent, the UI should show the Fleet Ops API disabled state for permitted users.
- Business panels should not silently load while disabled.
- No Fleet Ops write or execute feature flag exists.
- API/Web restart or redeploy may be required after changing the flag, depending on deployment path.

## Production Smoke Checks After Enablement

Run these checks after a GO decision, feature flag enablement, and any required restart/redeploy:

| Check | Expected result | Evidence |
| --- | --- | --- |
| `/system/permissions` | Shows `车队运营查看 / fleet_ops:read`. | Screenshot. |
| `/auth/me` permissions | Includes `fleet_ops:read` for authorized roles. | Redacted snippet. |
| `/auth/me` menus | Includes `/fleet-ops` or `vehicles.fleet_ops`. | Redacted snippet. |
| Sidebar | Shows `车队运营`. | Screenshot. |
| ADMIN access | `/fleet-ops` opens for ADMIN. | Screenshot. |
| OP/GM access | Opens if production policy approves OP/GM access. | Screenshot or note. |
| Non-granted role | Denied or menu hidden. | Screenshot or note. |
| Empty vehicle state | `/fleet-ops` without `vehicleId` shows empty state. | Screenshot. |
| Valid vehicle snapshot | Safe `vehicleId` loads snapshot. | Screenshot and selected vehicleId. |
| State card | Visible where data exists. | Screenshot. |
| Timeline card | Visible where data exists. | Screenshot. |
| Economics card | Visible where data exists. | Screenshot. |
| Risk card | Visible where data exists. | Screenshot. |
| Evidence/warnings/confidence | Visible or represented as empty state. | Screenshot. |
| API health | Fleet Ops health available for permitted user. | Health response summary. |
| Read-only boundary | No execution/write controls visible. | Checklist note and screenshot. |
| Rollback disabled state | If rollback tested, flag off shows disabled state. | Screenshot. |

Forbidden visible controls include execution, allocation, activation, collection action, mutation, recovery, or workflow triggering.

## Observability And Evidence Capture

Capture the production readiness evidence packet without storing passwords, bearer tokens, session cookies, or full customer-sensitive payloads.

| Field | Value |
| --- | --- |
| Operator |  |
| Timestamp |  |
| Environment | production |
| API commit or image tag |  |
| Web commit or image tag |  |
| DB target |  |
| Feature flag value |  |
| Access sync run | yes / no |
| Selected vehicleId |  |
| Permission page screenshot |  |
| Sidebar screenshot |  |
| `/fleet-ops` screenshot |  |
| `/auth/me` permission snippet |  |
| `/auth/me` menu snippet |  |
| API health result |  |
| Smoke result |  |
| Rollback result if tested |  |
| Errors or warnings observed |  |

## Go / No-Go Criteria

Mark GO only if all of these are true:

- Mandatory automated gates pass.
- Production API/Web image alignment is completed.
- P1-H13 staging smoke evidence exists.
- ADMIN / OP / GM access policy is approved.
- Rollback owner is identified.
- Feature flag owner is identified.
- No write or execution exposure is found.
- No unexpected customer/public Fleet Ops route is found.
- API health is available for a permitted user.
- Production smoke checks pass.
- Evidence is captured.

Mark NO-GO if any of these are true:

- Permission or menu is missing for an authorized role.
- API returns unexpected `403` for authorized roles.
- A non-granted role can access Fleet Ops.
- Execution or write controls appear.
- API/Web versions are mismatched.
- Production image alignment has not been completed.
- Selected vehicle snapshot fails unexpectedly.
- Evidence, warnings, or confidence are missing from expected read-only outputs.
- Rollback owner or feature flag owner is not confirmed.
- Production DB target is unclear.

## Rollback

To disable Fleet Ops production exposure:

1. Set `FLEET_OPS_API_ENABLED=false`.
2. Restart or redeploy API/Web if required by the deployment path.
3. Log out and log in again.
4. Confirm `/fleet-ops` shows the API disabled state for permitted users.
5. Communicate disabled state to operators.
6. Capture rollback evidence.

Permission and menu DB entries may remain. No schema rollback is needed. No data rollback is needed. No execution/write cleanup is needed because Fleet Ops production exposure is read-only.

## Owner Sign-Offs

| Role | Owner | Decision | Notes |
| --- | --- | --- | --- |
| Product/operations owner |  | GO / NO-GO |  |
| Engineering owner |  | GO / NO-GO |  |
| Data/DB owner |  | GO / NO-GO |  |
| Security/permission owner |  | GO / NO-GO |  |
| Rollback owner |  | Confirmed / Not confirmed |  |
| Feature flag owner |  | Confirmed / Not confirmed |  |

## Known Gaps And Deferred Items

These are out of scope for the current read-only production readiness decision:

- Production monitoring dashboard.
- Structured API error metrics.
- Audit/report export.
- UI polish.
- Role policy review beyond ADMIN / OP / GM read access.
- Automated production smoke.
- Later write/execution design.

Any later write or execution design must be a separate reviewed scope and must not be inferred from this read-only readiness checklist.
