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

Default decision status: `PENDING`.

## Release Candidate Identity

| Field | Value |
| --- | --- |
| Record date |  |
| Prepared by |  |
| Reviewer(s) |  |
| API commit or image tag |  |
| Web commit or image tag |  |
| Shared package commit or version, if relevant |  |
| Production DB target |  |
| Environment | production |
| Decision status | PENDING |

Allowed decision statuses:

- `PENDING`
- `GO`
- `GO_WITH_LIMITATIONS`
- `NO-GO`

## Evidence Baseline

P1-H13 and P1-H14 evidence should be available before the final production decision.

Known P1-H13 evidence categories:

| Evidence | Expected baseline | Actual evidence link / notes |
| --- | --- | --- |
| Web focused Fleet Ops tests | `fleet-ops-readonly`, `fleet-ops-api`, and `fleet-ops-view-model` passed. |  |
| Fleet Ops access sync | Completed for OP / GM / ADMIN. |  |
| API Fleet Ops RC gate | `pnpm --filter @subscription-saas/api test:fleet-ops` passed: 34 files / 139 tests. |  |
| API permission test | `pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts` passed: 69 tests. |  |
| API service status | Fleet Ops API service status was available. |  |
| Permission/menu checks | `fleet_ops:read`, `vehicles.fleet_ops`, and `/fleet-ops` were present for intended roles. |  |
| UI permission state | `/fleet-ops` no longer showed permission denied for authorized access. |  |
| Screenshot links | Permission page, sidebar, and `/fleet-ops` screenshots captured. |  |
| `/auth/me` snippets | Permissions and menus snippets captured without tokens or cookies. |  |
| Selected vehicleId | Known safe or anonymized vehicle selected for smoke. |  |
| Production smoke evidence | To be captured after approved production enablement. |  |

## Mandatory Gate Results

| Gate | Command | Expected result | Actual result | Status | Evidence link / notes |
| --- | --- | --- | --- | --- | --- |
| API Fleet Ops RC gate | `pnpm --filter @subscription-saas/api test:fleet-ops` | Pass |  |  |  |
| API permission test | `pnpm --filter @subscription-saas/api exec vitest run test/permissions.spec.ts` | Pass |  |  |  |
| Web Fleet Ops focused tests | `pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-readonly.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-view-model.spec.ts` | Pass |  |  |  |
| API typecheck | `pnpm --filter @subscription-saas/api typecheck` | Pass |  |  |  |
| API lint | `pnpm --filter @subscription-saas/api lint` | Pass |  |  |  |
| Web typecheck | `pnpm --filter @subscription-saas/web typecheck` | Pass |  |  |  |
| Web lint | `pnpm --filter @subscription-saas/web lint` | Pass |  |  |  |
| Shared typecheck, if available | `pnpm --filter @subscription-saas/shared typecheck` | Pass or not available |  |  |  |
| Shared lint, if available | `pnpm --filter @subscription-saas/shared lint` | Pass or not available |  |  |  |

## Access And Role Policy

| Item | Decision / Evidence |
| --- | --- |
| Permission | `fleet_ops:read` |
| Menu | `车队运营` / `/fleet-ops` |
| Provisioned roles | `ADMIN`, `OP`, `GM` |
| Excluded roles | `AS`, `FI`, `SA`, `RC`, `CS`, customer-like, and public roles unless separately approved. |
| Production DB target confirmed |  |
| Access sync required | yes / no |
| Access sync operator |  |
| Logout/login completed after sync | yes / no / not applicable |

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
| Feature flag owner |  |
| Rollback owner |  |
| Planned enable time |  |
| Planned observation window |  |
| Current decision | not enabled / approved to enable / enabled / rolled back |

This PR and this record do not enable production. Production enablement remains a separate human/operator action after an approved decision.

## Production Smoke Checklist

| Check | Role / condition | Expected | Actual | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| `/system/permissions` | Admin/system user | Shows `车队运营查看 / fleet_ops:read`. |  |  |  |
| `/auth/me` permissions | Authorized role | Includes `fleet_ops:read`. |  |  |  |
| `/auth/me` menus | Authorized role | Includes `/fleet-ops` or `vehicles.fleet_ops`. |  |  |  |
| Sidebar | Authorized role | Shows `车队运营`. |  |  |  |
| `/fleet-ops` ADMIN | `ADMIN` | Opens without permission denied. |  |  |  |
| `/fleet-ops` OP | `OP`, if policy approved | Opens without permission denied. |  |  |  |
| `/fleet-ops` GM | `GM`, if policy approved | Opens without permission denied. |  |  |  |
| Non-granted role | AS/FI/SA/RC/CS/customer-like/public | Denied or menu hidden. |  |  |  |
| Empty vehicle state | Authorized role, flag on | Empty state appears without error. |  |  |  |
| Valid vehicle snapshot | Authorized role, safe vehicleId | Snapshot loads. |  |  |  |
| State card | Valid vehicleId | State section visible where data exists. |  |  |  |
| Timeline card | Valid vehicleId | Timeline section visible where data exists. |  |  |  |
| Economics card | Valid vehicleId | Economics section visible where data exists. |  |  |  |
| Risk card | Valid vehicleId | Risk section visible where data exists. |  |  |  |
| Evidence/warnings/confidence | Valid vehicleId | Evidence, warnings, confidence, or empty equivalents are visible. |  |  |  |
| Read-only controls | Any Fleet Ops UI state | No execution/write controls visible. |  |  |  |
| API health | Authorized role, flag on | Fleet Ops health available. |  |  |  |
| Rollback disabled state | Flag rolled back | UI shows disabled state. |  |  |  |

## Read-Only Boundary Confirmation

Confirm each item before marking GO:

| Boundary | Expected | Status | Evidence / notes |
| --- | --- | --- | --- |
| Fleet Ops UI client methods | No `POST`, `PATCH`, `PUT`, or `DELETE` helpers. |  |  |
| Execution endpoints | No Fleet Ops execution endpoints exposed. |  |  |
| Action controls | No execution, allocation, activation, collection action, mutation, recovery, or workflow trigger controls. |  |  |
| Customer/public exposure | No customer/public portal Fleet Ops route or menu. |  |  |
| Permissions | No Fleet Ops write, execute, admin, action, allocate, or collect permissions. |  |  |
| Runtime scope | Fleet Ops remains read-only. |  |  |

## Risks And Limitations

| Risk / limitation | Impact | Mitigation / owner | Status |
| --- | --- | --- | --- |
| Sparse vehicle data | Snapshot panels may be partially empty. | Use known safe vehicleId and record sparse-data results. |  |
| API/Web version mismatch | UI may call incompatible API contract. | Confirm API/Web commit family before smoke. |  |
| Wrong DB sync target | Access sync could affect the wrong environment. | Confirm production DB target before any sync. |  |
| Stale login/session | `/auth/me` may not show updated permissions. | Logout/login after sync and flag changes. |  |
| Feature flag confusion | Disabled state may be mistaken for failure, or flag may be enabled prematurely. | Record feature flag owner and planned enable time. |  |
| Operators mistake dashboard for action workflow | Read-only view could imply operational actions. | Confirm no action controls and communicate read-only scope. |  |
| Evidence not captured | Decision becomes hard to audit. | Require screenshots/snippets before GO. |  |
| Role policy not approved | Unauthorized or overbroad access risk. | Require security/permission owner sign-off. |  |
| `GO_WITH_LIMITATIONS` overuse | Launch could proceed with unclear risk. | Require explicit limitations, owners, and due dates. |  |

## Go / No-Go Decision

Selectable outcomes:

- `GO`
- `GO_WITH_LIMITATIONS`
- `NO-GO`

| Field | Value |
| --- | --- |
| Decision |  |
| Decision owner |  |
| Decision timestamp |  |
| Rationale |  |
| Conditions / limitations |  |
| Required follow-ups |  |
| Rollback owner |  |
| Communication owner |  |

Decision rules:

- `GO` requires all mandatory gates, smoke evidence, role policy approval, rollback owner, feature flag owner, and owner sign-offs.
- `GO_WITH_LIMITATIONS` requires explicit limitations, owners, due dates, and evidence that read-only safety is preserved.
- `NO-GO` should list blocking reasons, retry criteria, and the next review owner.

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
| Product / operations owner |  |  |  |  |
| Engineering owner |  |  |  |  |
| Data / DB owner |  |  |  |  |
| Security / permission owner |  |  |  |  |
| Feature flag owner |  |  |  |  |
| Rollback owner |  |  |  |  |
| Communication owner |  |  |  |  |

## Follow-Up Items

| Item | Owner | Severity | Due date | Status | Notes |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |
