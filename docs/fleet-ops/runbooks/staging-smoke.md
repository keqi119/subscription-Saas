# Fleet Ops Staging Enablement And Smoke Runbook

## Purpose And Scope

Use this runbook to enable and smoke-test the Fleet Ops read-only staging experience after P1-H10.1 or a newer baseline has been deployed.

Fleet Ops staging enablement is read-only. It must not expose execution actions, write controls, customer/public routes, schema changes, migrations, production data mutation, or Fleet Ops write/execute/admin/action permissions.

This runbook covers:

- API feature flag enablement.
- Existing database access sync when permissions or menus are missing.
- ADMIN, OP, and GM access checks.
- `/fleet-ops` browser smoke checks.
- Rollback by disabling the feature flag.

## Preconditions

Confirm these before starting:

| Item | Expected |
| --- | --- |
| Code baseline | Latest main includes P1-H10.1 or newer. |
| API/Web alignment | API and Web are deployed from the same commit family. |
| Database | Staging DB connection is confirmed and is not production. |
| Accounts | ADMIN, OP, and GM accounts are available. |
| Denied role | One non-granted role account is available if possible, such as SA, FI, AS, RC, or CS. |
| Vehicle fixture | One known safe `vehicleId` exists for read-only smoke. |
| Data writes | No live DB writes are required except the optional idempotent Fleet Ops access sync. |
| Environment | Target is staging only, not production. |

## Environment And Config

Enable the API feature flag in the staging API environment:

```text
FLEET_OPS_API_ENABLED=true
```

If `FLEET_OPS_API_ENABLED=false` or is absent, the UI should show the Fleet Ops API disabled state and must not load business panels.

There are no Fleet Ops write, execute, admin, action, allocate, or collect feature flags. Rollback is performed by setting:

```text
FLEET_OPS_API_ENABLED=false
```

Then restart or redeploy API/Web as required by the staging deployment path.

## Access Sync

Run this only when an existing staging database does not yet contain Fleet Ops read access or menu entries.

```bash
pnpm --filter @subscription-saas/api prisma:sync:fleet-ops-access
```

The command is idempotent and safe to rerun. It affects only Fleet Ops read access:

- Permission: `fleet_ops:read`.
- Menu: `vehicles.fleet_ops`.
- Route: `/fleet-ops`.
- Roles: `ADMIN`, `OP`, `GM`.

It does not replace migrations, does not run the full seed, does not create business scenario data, and does not grant customer/public access.

After running the sync command, users must log out and log in again so `/auth/me` reloads DB-backed permissions and menus.

Codex automated verification must not run this command against a live database. It is a human/operator staging action.

## Deployment And Restart Flow

1. Pull or deploy the P1-H10.1-or-newer API image/code.
2. Pull or deploy the matching Web image/code from the same commit family.
3. Confirm the API environment includes `FLEET_OPS_API_ENABLED=true`.
4. Restart or redeploy the API service.
5. Restart or redeploy the Web service if the deployment method requires it.
6. Confirm API and Web versions or image tags point to the same release family.
7. Log out of the admin UI and log in again.

For image-based staging deployments, follow the main staging deployment runbook first:

```text
docs/staging-deployment-runbook.md
```

Then return here for Fleet Ops-specific smoke.

## Backend And API Verification

Use the authenticated staging admin session or existing smoke tooling. Do not paste bearer tokens or session cookies into committed docs or reports.

Check `/auth/me`:

- `permissions` includes `fleet_ops:read`.
- `menus` includes `/fleet-ops` or `vehicles.fleet_ops`.

Check Fleet Ops health:

```bash
curl "<STAGING_API_BASE_URL>/api/fleet-ops/health?requestId=fleet-ops-staging-smoke"
```

Expected outcomes:

| Condition | Expected result |
| --- | --- |
| Permission missing | `403` or permission denied. |
| Feature flag off | Health envelope is reachable for permitted users and reports disabled state, or business endpoints return disabled/forbidden according to API behavior. |
| Feature flag on and permission present | Health response is enabled/healthy enough to proceed with UI smoke. |
| Business endpoint while flag off | Blocked and represented as disabled/forbidden, not silently loaded. |

Optional endpoint checks for a safe vehicle:

```bash
curl "<STAGING_API_BASE_URL>/api/fleet-ops/vehicles/<VEHICLE_ID>/snapshot?requestId=fleet-ops-staging-smoke"
curl "<STAGING_API_BASE_URL>/api/fleet-ops/vehicles/<VEHICLE_ID>/state?requestId=fleet-ops-staging-smoke"
curl "<STAGING_API_BASE_URL>/api/fleet-ops/vehicles/<VEHICLE_ID>/timeline?requestId=fleet-ops-staging-smoke"
curl "<STAGING_API_BASE_URL>/api/fleet-ops/vehicles/<VEHICLE_ID>/economics?requestId=fleet-ops-staging-smoke"
curl "<STAGING_API_BASE_URL>/api/fleet-ops/vehicles/<VEHICLE_ID>/risk?requestId=fleet-ops-staging-smoke"
```

Use the authenticated session convention already approved for staging. Do not expose credentials, tokens, or cookies in evidence artifacts.

## Frontend And Browser Verification

1. Log in as ADMIN.
2. Confirm the sidebar shows `车队运营`.
3. Open `/fleet-ops`.
4. Confirm the page does not show `无权访问` for ADMIN.
5. With no `vehicleId`, confirm the empty state is shown.
6. Enter the known safe `vehicleId`.
7. Load the snapshot.
8. Confirm these read-only sections are visible where data exists:
   - Overview / confidence / consistency.
   - State card.
   - Timeline card and warnings.
   - Economics card with revenue, cashflow, deposit exclusion, ROI/ROE, and denominator evidence when available.
   - Risk card with overdue exposure, D1-D5 aging bucket, arrears pipeline, and warnings when available.
   - Evidence / warnings / confidence panel.
9. Confirm no execution/write controls are visible.

Forbidden controls include action labels or buttons for execution, allocation, activation, collection action, mutation, recovery, or workflow triggering.

## Role Smoke Matrix

| Scenario | Precondition | Steps | Expected result | Evidence to capture | Status |
| --- | --- | --- | --- | --- | --- |
| ADMIN access | ADMIN has `fleet_ops:read`; flag on | Login as ADMIN, open `/fleet-ops` | Sidebar shows `车队运营`; page loads non-denied state | Sidebar and page screenshot; `/auth/me` snippet |  |
| OP access | OP has `fleet_ops:read`; flag on | Login as OP, open `/fleet-ops` | Same as ADMIN | Sidebar and page screenshot; `/auth/me` snippet |  |
| GM access | GM has `fleet_ops:read`; flag on | Login as GM, open `/fleet-ops` | Same as ADMIN | Sidebar and page screenshot; `/auth/me` snippet |  |
| Non-granted role denied | SA/FI/AS/RC/CS lacks `fleet_ops:read` | Login as non-granted role, open `/fleet-ops` if route is reachable | Permission denied or menu hidden | Permission-denied screenshot or missing-menu evidence |  |
| Feature flag off | `FLEET_OPS_API_ENABLED=false` | Login as permitted user, open `/fleet-ops` | API disabled state appears; business panels do not load | Disabled-state screenshot |  |
| Feature flag on | `FLEET_OPS_API_ENABLED=true` | Login as permitted user, refresh `/fleet-ops` | Health state no longer reports disabled | Health/page screenshot |  |
| Missing vehicleId | Permitted user; flag on | Open `/fleet-ops` without vehicleId | Empty state appears, not an error | Empty-state screenshot |  |
| Valid vehicleId | Known safe vehicleId | Load snapshot | Snapshot sections render with available data | Snapshot screenshot and selected vehicleId |  |
| No execution controls | Any rendered snapshot | Inspect page actions and labels | No execution/write/mutation controls are present | Screenshot or checklist note |  |
| Evidence/warnings/confidence visible | Snapshot has enough source data | Inspect overview/evidence panels | Evidence groups, warnings, confidence, or empty equivalents are visible | Evidence panel screenshot |  |

## Rollback

To disable Fleet Ops staging exposure:

1. Set `FLEET_OPS_API_ENABLED=false` in the staging API environment.
2. Restart or redeploy API/Web if required by the deployment path.
3. Log out and log in again.
4. Confirm `/fleet-ops` shows the API disabled state for permitted users.

Permission and menu DB entries may remain in place. No schema rollback is needed. No data rollback is needed. No execution/write cleanup is needed because this surface is read-only.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `/system/permissions` does not show `fleet_ops:read` | Existing DB predates P1-H10 | Run `pnpm --filter @subscription-saas/api prisma:sync:fleet-ops-access`, then re-login. |
| Sidebar lacks `车队运营` | Menu missing, role-menu link missing, or stale session | Run access sync if needed, then log out/in and check `/auth/me`. |
| `/fleet-ops` shows `无权访问` | Current user lacks `fleet_ops:read` or session is stale | Check `/auth/me.permissions`; re-login after sync. |
| Health endpoint returns `403` | Permission missing or unauthenticated request | Use an authenticated ADMIN/OP/GM session and verify `fleet_ops:read`. |
| Page shows API disabled | `FLEET_OPS_API_ENABLED` is false or not applied | Set flag true and restart/redeploy API. |
| Logout/login does not refresh access | Browser/session cache or API/Web mismatch | Clear browser session, confirm API/Web commit family, retry login. |
| Valid vehicleId returns sparse panels | Vehicle has limited source data | Use another known safe vehicleId or record sparse-data result. |
| Snapshot fails only in browser | API base URL or CORS mismatch | Confirm `NEXT_PUBLIC_API_BASE_URL`, CORS, and Web build target. |
| API works but Web still disabled | Web and API deployed from different releases | Redeploy matching API/Web commit family. |
| Data appears from wrong environment | Incorrect staging DB connection | Stop smoke and verify `DATABASE_URL` points to staging. |

## Evidence Capture

Record the smoke result in the release or staging evidence packet.

| Field | Value |
| --- | --- |
| Operator |  |
| Date/time |  |
| Environment | staging |
| API commit or image tag |  |
| Web commit or image tag |  |
| DB target |  |
| Selected vehicleId |  |
| `/auth/me` permission snippet |  |
| `/auth/me` menu snippet |  |
| Permission page screenshot |  |
| Sidebar screenshot |  |
| `/fleet-ops` screenshot |  |
| Smoke matrix result |  |
| Rollback result if tested |  |

Do not store passwords, session cookies, bearer tokens, or full customer-sensitive payloads in the evidence packet.
