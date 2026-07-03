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

P1-H16 completion note:

- This record is not production approval.
- This PR does not enable production.
- The production feature flag remains disabled unless a later human/operator decision changes it.
- No live database sync is run by this PR.
- The final decision owner is still required.
- Known evidence below is a P1-H13 local/staging evidence baseline, not production smoke evidence.

## Release Candidate Identity

| Field | Value |
| --- | --- |
| Record date | TBD - human required |
| Prepared by | TBD - human required |
| Reviewer(s) | TBD - human required |
| API commit or image tag | TBD - human required |
| Web commit or image tag | TBD - human required |
| Shared package commit or version, if relevant | TBD - human required |
| Production DB target | TBD - human required |
| Environment | production - TBD human confirmation required |
| Decision status | PENDING |

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
| Selected vehicleId | Known safe or anonymized vehicle selected for smoke. | TBD - human required for production. |
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
| Production access policy approval | TBD - human required |
| Production DB target confirmed | TBD - human required |
| Access sync required | TBD - human required |
| Access sync operator | TBD - human required |
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
| Feature flag owner | TBD - human required |
| Rollback owner | TBD - human required |
| Planned enable time | TBD - human required |
| Planned observation window | TBD - human required |
| Current decision | not enabled / PENDING |

This PR and this record do not enable production. Production enablement remains a separate human/operator action after an approved decision.

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
| Valid vehicle snapshot | Authorized role, safe vehicleId | Snapshot loads. | TBD - production run required. | TBD | Selected production vehicleId: TBD - human required. |
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
| Runtime scope | Fleet Ops remains read-only. | P1-H13 local/staging baseline captured; production confirmation TBD. | Production enablement decision remains PENDING. |

## Risks And Limitations

| Risk / limitation | Impact | Mitigation / owner | Status |
| --- | --- | --- | --- |
| Sparse vehicle data | Snapshot panels may be partially empty. | Use known safe vehicleId and record sparse-data results. | Production vehicleId TBD - human required. |
| API/Web version mismatch | UI may call incompatible API contract. | Confirm API/Web commit family before smoke. | Production API/Web commits TBD - human required. |
| Wrong DB sync target | Access sync could affect the wrong environment. | Confirm production DB target before any sync. | Production DB target TBD - human required. |
| Stale login/session | `/auth/me` may not show updated permissions. | Logout/login after sync and flag changes. | Production smoke procedure TBD - human required. |
| Feature flag confusion | Disabled state may be mistaken for failure, or flag may be enabled prematurely. | Record feature flag owner and planned enable time. | Feature flag owner and planned enable time TBD - human required. |
| Operators mistake dashboard for action workflow | Read-only view could imply operational actions. | Confirm no action controls and communicate read-only scope. | Communication owner TBD - human required. |
| Evidence not captured | Decision becomes hard to audit. | Require screenshots/snippets before GO. | Production evidence TBD - production run required. |
| Role policy not approved | Unauthorized or overbroad access risk. | Require security/permission owner sign-off. | Production access policy approval TBD - human required. |
| `GO_WITH_LIMITATIONS` overuse | Launch could proceed with unclear risk. | Require explicit limitations, owners, and due dates. | Final decision remains PENDING. |

## Go / No-Go Decision

Selectable outcomes:

- `GO`
- `GO_WITH_LIMITATIONS`
- `NO-GO`

| Field | Value |
| --- | --- |
| Decision | PENDING |
| Decision owner | TBD - human required |
| Decision timestamp | TBD - human required |
| Rationale | Known P1-H13 local/staging evidence baseline is captured; production decision remains pending human approval and production-specific evidence. |
| Conditions / limitations | TBD - human required |
| Required follow-ups | See Follow-Up Items. |
| Rollback owner | TBD - human required |
| Communication owner | TBD - human required |

Decision rules:

- `GO` requires all mandatory gates, smoke evidence, role policy approval, rollback owner, feature flag owner, and owner sign-offs.
- `GO_WITH_LIMITATIONS` requires explicit limitations, owners, due dates, and evidence that read-only safety is preserved.
- `NO-GO` should list blocking reasons, retry criteria, and the next review owner.

The final decision remains `PENDING` until explicit human production approval exists. `GO` or `GO_WITH_LIMITATIONS` requires completed production fields, owners, limitations if any, and production smoke evidence.

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
| Feature flag owner | TBD - human required | PENDING | TBD - human required | Must own enablement and rollback flag changes. |
| Rollback owner | TBD - human required | PENDING | TBD - human required | Must be identified before enablement. |
| Communication owner | TBD - human required | PENDING | TBD - human required | Must own operator communication. |

## Follow-Up Items

| Item | Owner | Severity | Due date | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| Confirm production DB target before any access sync | TBD - human required | High | TBD - human required | PENDING | Required to avoid syncing the wrong environment. |
| Confirm production API/Web commit family | TBD - human required | High | TBD - human required | PENDING | API and Web commits or image tags must be recorded. |
| Assign production decision, feature flag, rollback, and communication owners | TBD - human required | High | TBD - human required | PENDING | Required before production approval. |
| Decide whether production access sync is required | TBD - human required | High | TBD - human required | PENDING | If required, it must be run by an authorized operator only. |
| Decide whether and when to enable `FLEET_OPS_API_ENABLED=true` | TBD - human required | High | TBD - human required | PENDING | This PR does not enable production. |
| Capture production smoke evidence | TBD - human required | High | TBD - human required | PENDING | Include `/auth/me`, sidebar, `/fleet-ops`, API health, and read-only boundary evidence. |
| Confirm rollback drill or rollback procedure | TBD - human required | Medium | TBD - human required | PENDING | Rollback is `FLEET_OPS_API_ENABLED=false` plus restart/redeploy if needed. |
| Prepare operator communication plan | TBD - human required | Medium | TBD - human required | PENDING | Must state Fleet Ops is read-only and not an action workflow. |
