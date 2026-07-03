# Fleet Ops Production GO / NO-GO Record

## Purpose And Scope

Use this record to capture the human production decision for the read-only Fleet Ops API and admin UI.

This is a Fleet Ops production decision record only. It does not enable production, does not approve production by itself, and does not change feature flag defaults, schema, migrations, permissions, seed data, sync behavior, API logic, UI behavior, package scripts, or production data.

This record is limited to:

- Read-only Fleet Ops API and admin UI.
- Existing `fleet_ops:read` permission and `/fleet-ops` menu access.
- Operator-controlled production feature flag decisions.
- Evidence capture, owner sign-offs, rollback ownership, and follow-up tracking.

This record explicitly excludes:

- Execution or write actions.
- Fleet Ops write, execute, admin, action, allocate, or collect permissions.
- Customer/public portal exposure.
- Production data mutation by Fleet Ops.
- Schema or migration changes.

Decision status: `GO`.

P1-H17 finalization note:

- This record captures the explicit human GO decision for controlled read-only Fleet Ops production readiness.
- This record does not itself enable production.
- This PR does not enable production.
- The production feature flag remains operator-controlled.
- Production access sync remains operator-controlled.
- No live database sync is run by this PR.
- No production database query is run by this PR.
- Known evidence below is a P1-H13 local/staging evidence baseline, not production smoke evidence.

## Release Candidate Identity

| Field | Value |
| --- | --- |
| Record date | TBD - human to fill at execution time |
| Prepared by | TBD - human to fill at execution time |
| Reviewer(s) | TBD - human to fill at execution time |
| API commit or image tag | TBD - human to fill at execution time |
| Web commit or image tag | TBD - human to fill at execution time |
| Shared package commit or version, if relevant | TBD - human to fill at execution time |
| Production DB target | `prod-primary` alias only. Operator must confirm the target before access sync; do not record plaintext DSN, password, token, or connection string. |
| Environment | production |
| Decision status | GO |

Allowed decision statuses:

- `PENDING`
- `GO`
- `GO_WITH_LIMITATIONS`
- `NO-GO`

## Evidence Baseline

P1-H13 and P1-H14 evidence should be available before the final production decision.

The evidence below is the P1-H13 local/staging evidence baseline provided for production review. It is not production smoke evidence and must not be treated as production approval.

| Evidence | Expected baseline | Actual evidence link / notes |
| --- | --- | --- |
| Web focused Fleet Ops tests | `fleet-ops-readonly`, `fleet-ops-api`, and `fleet-ops-view-model` passed. | P1-H13 local/staging evidence provided by user: passed. Production rerun: TBD - production run required. |
| Fleet Ops access sync | Completed for OP / GM / ADMIN. | P1-H13 local/staging evidence provided by user: sync completed for permission `fleet_ops:read`, menu `vehicles.fleet_ops` / `/fleet-ops`, and roles OP / GM / ADMIN. Production access policy approval and sync decision: TBD - human required. |
| API Fleet Ops RC gate | `pnpm --filter @subscription-saas/api test:fleet-ops` passed: 34 files / 139 tests. | P1-H13 local/staging evidence provided by user: passed, 34 files / 139 tests. Production rerun: TBD - production run required. |
| API permission test | `pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts` passed: 69 tests. | P1-H13 local/staging evidence provided by user: passed, 69 tests. Production rerun: TBD - production run required. |
| API service status | Fleet Ops API service status was available. | P1-H13 local/staging evidence provided by user: available. Production health check: TBD - production run required. |
| Permission/menu checks | `fleet_ops:read`, `vehicles.fleet_ops`, and `/fleet-ops` were present for intended roles. | P1-H13 local/staging evidence provided by user: `/system/permissions` showed `车队运营查看 / fleet_ops:read`; sidebar showed `车队运营`; `/auth/me` permissions included `fleet_ops:read`; `/auth/me` menus included `/fleet-ops`. Production evidence: TBD - production run required. |
| UI permission state | `/fleet-ops` no longer showed permission denied for authorized access. | P1-H13 local/staging evidence provided by user: `/fleet-ops` no longer showed permission denied. Production evidence: TBD - production run required. |
| Screenshot links | Permission page, sidebar, and `/fleet-ops` screenshots captured. | TBD - human required for production evidence links. |
| `/auth/me` snippets | Permissions and menus snippets captured without tokens or cookies. | P1-H13 local/staging baseline confirmed by user; production redacted snippets remain TBD - human required. |
| Selected vehicleId | Known safe or anonymized vehicle selected for smoke. | Actual vehicleId: TBD - pre-enable confirmation required. Selection rule: choose the most recently registered vehicle from the `prod-primary` vehicle library before production smoke. |
| Production smoke evidence | To be captured after approved production enablement. | TBD - production run required. |

## Mandatory Gate Results

Known local/staging gate results are recorded as baseline evidence only. Production actual results remain `TBD - production run required` until an authorized production readiness run completes.

| Gate | Command | Expected result | Actual result | Status | Evidence link / notes |
| --- | --- | --- | --- | --- | --- |
| API Fleet Ops RC gate | `pnpm --filter @subscription-saas/api test:fleet-ops` | Pass | P1-H13 local/staging baseline: passed, 34 files / 139 tests. Production actual: TBD - production run required. | Baseline captured; production TBD. | User-provided P1-H13 evidence. |
| API permission test | `pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts` | Pass | P1-H13 local/staging baseline: passed, 69 tests. Production actual: TBD - production run required. | Baseline captured; production TBD. | User-provided P1-H13 evidence. |
| Web Fleet Ops focused tests | `pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-readonly.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-view-model.spec.ts` | Pass | P1-H13 local/staging baseline: passed. Production actual: TBD - production run required. | Baseline captured; production TBD. | User-provided P1-H13 evidence. |
| API typecheck | `pnpm --filter @subscription-saas/api typecheck` | Pass | TBD - production run required. | TBD |  |
| API lint | `pnpm --filter @subscription-saas/api lint` | Pass | TBD - production run required. | TBD |  |
| Web typecheck | `pnpm --filter @subscription-saas/web typecheck` | Pass | TBD - production run required. | TBD |  |
| Web lint | `pnpm --filter @subscription-saas/web lint` | Pass | TBD - production run required. | TBD |  |
| Shared typecheck, if available | `pnpm --filter @subscription-saas/shared typecheck` | Pass or not available | TBD - production run required. | TBD |  |
| Shared lint, if available | `pnpm --filter @subscription-saas/shared lint` | Pass or not available | TBD - production run required. | TBD |  |

## Access And Role Policy

| Item | Decision / Evidence |
| --- | --- |
| Permission | `fleet_ops:read` |
| Menu | `车队运营` / `/fleet-ops` |
| Known local/staging baseline | Permission `fleet_ops:read`, menu `vehicles.fleet_ops` / `/fleet-ops`, and roles OP / GM / ADMIN were confirmed in P1-H13 local/staging evidence. |
| Provisioned roles | `ADMIN`, `OP`, `GM` |
| Excluded roles | `AS`, `FI`, `SA`, `RC`, `CS`, customer-like, and public roles unless separately approved. |
| Production access policy approval | GO recorded for controlled read-only readiness from explicit human decision input; production enablement actions remain operator-controlled. |
| Production DB target confirmed | `prod-primary` alias recorded. Operator must confirm the actual production DB target before access sync; do not record plaintext DSN, password, token, or connection string. |
| Access sync required | TBD - operator to decide after checking `prod-primary` permissions and menus. |
| Access sync operator | TBD - human to fill at execution time |
| Logout/login completed after sync | P1-H13 local/staging baseline confirmed after sync; production TBD - human required. |

Access sync command for authorized human operators only:

```bash
pnpm --filter @subscription-saas/api prisma:sync:fleet-ops-access
```

Access sync rules:

- Confirm production `DATABASE_URL` before running.
- Affects only Fleet Ops read permission, menu, and role links.
- Roles: `ADMIN`, `OP`, and `GM`.
- Requires logout/login after sync so `/auth/me` reloads DB-backed permissions and menus.
- Does not run the full seed.
- Does not change schema.
- Does not add migrations.
- Does not add write, execute, admin, action, allocate, or collect permissions.
- Must not be run by Codex automated verification.

## Feature Flag Decision

| Field | Value |
| --- | --- |
| Current default | Disabled unless approved. |
| Enable key | `FLEET_OPS_API_ENABLED=true` |
| Rollback key | `FLEET_OPS_API_ENABLED=false` |
| Feature flag owner | Ke Li |
| Rollback owner | Ke Li |
| Planned enable time | `2026-01-01 00:00 UTC+08` |
| Planned observation window | Active observation: 2 hours; passive observation: 24 hours. |
| Current decision | GO recorded for controlled read-only readiness; production feature flag is not enabled by this PR. |

This PR and this record do not enable production. Production enablement remains a separate human/operator action after an approved decision.

The planned enable time `2026-01-01 00:00 UTC+08` is already elapsed and must be re-confirmed by Ke Li before actual production enablement.

## Pre-Enable Conditions

Before any operator enables production:

- Confirm the `prod-primary` DB target before running access sync.
- Confirm the actual selected production vehicleId before production smoke.
- Run access sync only against the confirmed production DB if needed:

```bash
pnpm --filter @subscription-saas/api prisma:sync:fleet-ops-access
```

- Enable `FLEET_OPS_API_ENABLED=true` only in the approved operator window.
- Restart or redeploy API/Web if required.
- Re-login after sync or feature flag changes.
- Run production smoke.
- Roll back by setting `FLEET_OPS_API_ENABLED=false`.

## Production Smoke Checklist

| Check | Role / condition | Expected | Actual | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| `/system/permissions` | Admin/system user | Shows `车队运营查看 / fleet_ops:read`. | P1-H13 local/staging baseline passed; production actual TBD - production run required. | Baseline captured; production TBD. | User-provided P1-H13 context; production screenshot TBD. |
| `/auth/me` permissions | Authorized role | Includes `fleet_ops:read`. | P1-H13 local/staging baseline passed; production actual TBD - production run required. | Baseline captured; production TBD. | User-provided P1-H13 context; production redacted snippet TBD. |
| `/auth/me` menus | Authorized role | Includes `/fleet-ops` or `vehicles.fleet_ops`. | P1-H13 local/staging baseline passed; production actual TBD - production run required. | Baseline captured; production TBD. | User-provided P1-H13 context; production redacted snippet TBD. |
| Sidebar | Authorized role | Shows `车队运营`. | P1-H13 local/staging baseline passed; production actual TBD - production run required. | Baseline captured; production TBD. | User-provided P1-H13 context; production screenshot TBD. |
| `/fleet-ops` ADMIN | `ADMIN` | Opens without permission denied. | P1-H13 local/staging baseline passed; production actual TBD - production run required. | Baseline captured; production TBD. | User-provided P1-H13 context; production screenshot TBD. |
| `/fleet-ops` OP | `OP`, if policy approved | Opens without permission denied. | P1-H13 local/staging access sync baseline completed; production actual TBD - production run required. | Baseline captured; production TBD. | Production OP policy approval TBD - human required. |
| `/fleet-ops` GM | `GM`, if policy approved | Opens without permission denied. | P1-H13 local/staging access sync baseline completed; production actual TBD - production run required. | Baseline captured; production TBD. | Production GM policy approval TBD - human required. |
| Non-granted role | AS/FI/SA/RC/CS/customer-like/public | Denied or menu hidden. | TBD - production run required. | TBD |  |
| Empty vehicle state | Authorized role, flag on | Empty state appears without error. | TBD - production run required. | TBD |  |
| Valid vehicle snapshot | Authorized role, safe vehicleId | Snapshot loads. | TBD - production run required. | TBD | Actual vehicleId: TBD - pre-enable confirmation required. Selection rule: choose the most recently registered vehicle from the `prod-primary` vehicle library before production smoke. |
| State card | Valid vehicleId | State section visible where data exists. | TBD - production run required. | TBD |  |
| Timeline card | Valid vehicleId | Timeline section visible where data exists. | TBD - production run required. | TBD |  |
| Economics card | Valid vehicleId | Economics section visible where data exists. | TBD - production run required. | TBD |  |
| Risk card | Valid vehicleId | Risk section visible where data exists. | TBD - production run required. | TBD |  |
| Evidence/warnings/confidence | Valid vehicleId | Evidence, warnings, confidence, or empty equivalents are visible. | TBD - production run required. | TBD |  |
| Read-only controls | Any Fleet Ops UI state | No execution/write controls visible. | P1-H13 local/staging baseline: web readonly guard passed; production visual confirmation TBD - production run required. | Baseline captured; production TBD. | Production screenshot/checklist TBD. |
| API health | Authorized role, flag on | Fleet Ops health available. | P1-H13 local/staging baseline: Fleet Ops API service status available; production actual TBD - production run required. | Baseline captured; production TBD. | Production health evidence TBD. |
| Rollback disabled state | Flag rolled back | UI shows disabled state. | TBD - human required if rollback drill is tested. | TBD |  |

## Read-Only Boundary Confirmation

Confirm each item before marking GO:

| Boundary | Expected | Status | Evidence / notes |
| --- | --- | --- | --- |
| Fleet Ops UI client methods | No `POST`, `PATCH`, `PUT`, or `DELETE` helpers. | P1-H13 local/staging baseline captured; production confirmation TBD. | Web readonly guard passed in P1-H13 evidence. |
| Execution endpoints | No Fleet Ops execution endpoints exposed. | P1-H13 local/staging baseline captured; production confirmation TBD. | Web readonly guard and API Fleet Ops gates passed in P1-H13 evidence. |
| Action controls | No execution, allocation, activation, collection action, mutation, recovery, or workflow trigger controls. | P1-H13 local/staging baseline captured; production visual confirmation TBD. | Production screenshot/checklist remains TBD - production run required. |
| Customer/public exposure | No customer/public portal Fleet Ops route or menu. | P1-H13 local/staging baseline captured; production confirmation TBD. | Web readonly guard passed in P1-H13 evidence. |
| Permissions | No Fleet Ops write, execute, admin, action, allocate, or collect permissions. | P1-H13 local/staging baseline captured; production confirmation TBD. | API permissions test passed in P1-H13 evidence. |
| Runtime scope | Fleet Ops remains read-only. | P1-H13 local/staging baseline captured; production confirmation TBD. | GO approves controlled read-only readiness only; production enablement remains operator-controlled. |

## Risks And Limitations

| Risk / limitation | Impact | Mitigation / owner | Status |
| --- | --- | --- | --- |
| Sparse vehicle data | Snapshot panels may be partially empty. | Use known safe vehicleId and record sparse-data results. | Production vehicleId TBD - human required. |
| API/Web version mismatch | UI may call incompatible API contract. | Confirm API/Web commit family before smoke. | Production API/Web commits TBD - human required. |
| Wrong DB sync target | Access sync could affect the wrong environment. | Confirm production DB target before any sync. | Production DB target TBD - human required. |
| Stale login/session | `/auth/me` may not show updated permissions. | Logout/login after sync and flag changes. | Production smoke procedure TBD - human required. |
| Feature flag confusion | Disabled state may be mistaken for failure, or flag may be enabled prematurely. | Ke Li owns the feature flag decision; planned enable time requires re-confirmation before any change. | Owner captured; actual feature flag change remains operator-controlled. |
| Elapsed planned enable time | The supplied `2026-01-01 00:00 UTC+08` timestamp is already elapsed. | Ke Li must re-confirm the actual enable window before any `FLEET_OPS_API_ENABLED=true` change. | GO record captured; actual enablement blocked until re-confirmed. |
| Operators mistake dashboard for action workflow | Read-only view could imply operational actions. | Ke Li owns communication; confirm no action controls and communicate read-only scope. | Communication owner captured; operator communication still pending. |
| Evidence not captured | Decision becomes hard to audit. | Require screenshots/snippets before GO. | Production evidence TBD - production run required. |
| Role policy not approved | Unauthorized or overbroad access risk. | Require security/permission owner sign-off. | Production access policy approval TBD - human required. |
| `GO_WITH_LIMITATIONS` overuse | Launch could proceed with unclear risk. | Require explicit limitations, owners, and due dates. | Not selected for this decision record. |

## Go / No-Go Decision

Selectable outcomes:

- `GO`
- `GO_WITH_LIMITATIONS`
- `NO-GO`

| Field | Value |
| --- | --- |
| Decision | GO |
| Decision owner | Ke Li |
| Decision timestamp | TBD - human to fill at execution time |
| Rationale | Fleet Ops read-only API/UI, permission/menu provisioning, idempotent access sync, RC gates, staging/local smoke, readonly static guard, production readiness checklist, and decision record baseline are complete. |
| Conditions / limitations | Production enablement remains operator-controlled; complete the pre-enable conditions before sync, feature flag change, restart/redeploy, and smoke. |
| Required follow-ups | See Follow-Up Items. |
| Rollback owner | Ke Li |
| Communication owner | Ke Li |

Decision rules:

- `GO` requires all mandatory gates, smoke evidence, role policy approval, rollback owner, feature flag owner, and owner sign-offs.
- `GO_WITH_LIMITATIONS` requires explicit limitations, owners, due dates, and evidence that read-only safety is preserved.
- `NO-GO` should list blocking reasons, retry criteria, and the next review owner.

Selected decision: `GO`.

The selected `GO` approves controlled read-only Fleet Ops production readiness only. `GO` does not enable production by itself. Actual access sync, feature flag enablement, restart/redeploy, production smoke, and rollback remain human/operator-controlled. `GO_WITH_LIMITATIONS` is not selected.

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

| Owner area | Name | Decision / approval | Timestamp | Notes |
| --- | --- | --- | --- | --- |
| Product / operations owner | TBD - human required | PENDING | TBD - human required | Required before production approval. |
| Engineering owner | TBD - human required | PENDING | TBD - human required | Required before production approval. |
| Data / DB owner | TBD - human required | PENDING | TBD - human required | Must confirm production DB target before any sync. |
| Security / permission owner | TBD - human required | PENDING | TBD - human required | Must approve production access policy. |
| Decision owner | Ke Li | GO | TBD - human to fill at execution time | GO recorded from explicit human decision input; production enablement remains separate. |
| Feature flag owner | Ke Li | GO | TBD - human to fill at execution time | Owns enablement and rollback flag changes. |
| Rollback owner | Ke Li | GO | TBD - human to fill at execution time | Must confirm rollback readiness before enablement. |
| Communication owner | Ke Li | GO | TBD - human to fill at execution time | Must own operator communication. |

## Follow-Up Items

| Item | Owner | Severity | Due date | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| Confirm production DB target before any access sync | Ke Li / authorized operator | High | TBD - human to fill at execution time | PENDING | `prod-primary` alias is recorded; operator must confirm the actual target before sync. |
| Confirm production API/Web commit family | TBD - human required | High | TBD - human required | PENDING | API and Web commits or image tags must be recorded. |
| Confirm actual production vehicleId | Ke Li / authorized operator | High | TBD - human to fill at execution time | PENDING | Choose the most recently registered vehicle from the `prod-primary` vehicle library before production smoke; actual vehicleId remains TBD. |
| Re-confirm planned enable time | Ke Li | High | TBD - human to fill at execution time | PENDING | Supplied time `2026-01-01 00:00 UTC+08` is already elapsed and must be re-confirmed before enablement. |
| Decide whether production access sync is required | Ke Li / authorized operator | High | TBD - human to fill at execution time | PENDING | If required, run only against confirmed `prod-primary`. |
| Decide whether and when to enable `FLEET_OPS_API_ENABLED=true` | Ke Li | High | TBD - human to fill at execution time | PENDING | This PR does not enable production. |
| Capture production smoke evidence | Ke Li / authorized operator | High | TBD - human to fill at execution time | PENDING | Include `/auth/me`, sidebar, `/fleet-ops`, API health, and read-only boundary evidence. |
| Confirm rollback readiness before enablement | Ke Li | Medium | TBD - human to fill at execution time | PENDING | Rollback is `FLEET_OPS_API_ENABLED=false` plus restart/redeploy if needed. |
| Communicate read-only nature to ADMIN / OP / GM | Ke Li | Medium | TBD - human to fill at execution time | PENDING | Must state Fleet Ops is read-only and not an action workflow. |
