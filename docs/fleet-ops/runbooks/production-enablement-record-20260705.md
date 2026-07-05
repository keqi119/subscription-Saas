# Fleet Ops Production Enablement Record - 2026-07-05

## 1. Purpose And Scope

This is the Fleet Ops production enablement record for 2026-07-05.

This record documents completed human/operator production actions. It does not execute any production action by itself.

Fleet Ops remains read-only. No execution or write action was enabled.

## 2. Release Identity

| Field | Value |
| --- | --- |
| Target full SHA | `d444f5970194a540de584fb602cc808b569af50e` |
| Target short SHA | `d444f59` |
| Image tag | `prod-20260704-d444f59` |
| API image | `ghcr.io/keqi119/subscription-api:prod-20260704-d444f59` |
| API digest | `sha256:894ef2863934f5b8381e987944fc700178e05e230590f371ca595951cee50ae0` |
| Web image | `ghcr.io/keqi119/subscription-web:prod-20260704-d444f59` |
| Web digest | `sha256:0d0c760b8a1481eabc7e45c0936146245377ec1aae073f8e732e9a20ee2ea9f4` |

## 3. Migration Status

| Field | Value |
| --- | --- |
| Production datasource | PostgreSQL database `subscription_saas_prod`, schema `public`, at `postgres:5432` |
| Migration count | 58 migrations found |
| Final status | `Database schema is up to date!` |
| Codex migration action | None |
| Migration/deploy ownership | Human/operator-controlled |

## 4. API/Web Image Alignment

| Field | Value |
| --- | --- |
| API container image | `ghcr.io/keqi119/subscription-api:prod-20260704-d444f59` |
| Web container image | `ghcr.io/keqi119/subscription-web:prod-20260704-d444f59` |
| API/Web same image tag | yes |
| API/Web same target SHA | yes |
| API health after alignment | 200 OK |
| Web local check | 200 OK |
| Fleet Ops flag during image alignment | `FLEET_OPS_API_ENABLED=false` |

## 5. Access Sync

Fleet Ops access sync was run manually by the operator.

Result:

- Fleet Ops access sync completed.
- Permission: `fleet_ops:read`.
- Menu: `vehicles.fleet_ops` / `/fleet-ops`.
- Roles: `OP` / `GM` / `ADMIN`.
- No full seed.
- No execution/write permission.

## 6. Feature Flag Enablement

| Field | Value |
| --- | --- |
| Feature flag | `FLEET_OPS_API_ENABLED=true` |
| API restarted/recreated | yes |
| API health after enablement | 200 OK |
| Production enablement action | manual/operator-controlled |
| Codex production action | Codex did not enable production |

## 7. Fleet Ops UI Smoke

| Field | Value |
| --- | --- |
| URL | `https://admin.subauto.keybox.cloud/fleet-ops` |
| Result | Page opened and generated vehicle snapshot. |
| API service status | available |
| Selected vehicleId | `5e354d25-41ce-4432-9fc5-ea70e49a1b40` |
| generatedAt | `2026-07-05T04:01:24.292Z` |
| confidence | `45% LOW` |
| consistency | `100%` |
| warnings | 11 |
| evidence | 16 |

## 8. Snapshot Smoke Details

### State

| Field | Value |
| --- | --- |
| computed state | `AVAILABLE` |
| confidence | 80% |
| evidence | 1 |
| conflicts | 0 |

### Timeline

| Field | Value |
| --- | --- |
| range days | 1 |
| events | 1 |
| fallback days | 1 |
| warning | `CURRENT_STATUS_PROJECTED_ACROSS_RANGE` |

### Economics

| Field | Value |
| --- | --- |
| revenue | 0 |
| cost | 50 |
| ROI | -0.00% |
| ROE | -0.00% |
| denominator evidence | 2 |
| actual operating cashflow | 0 |
| actual deposit cashflow | 0 |
| excluded deposits | 0 |
| planned operating cashflow | 0 |
| planned deposit cashflow | 0 |

### Risk

| Field | Value |
| --- | --- |
| score | 33 |
| risk level | `NONE` |
| collection level | `NONE` |
| aging bucket | `NONE` |
| overdue amount | 0 |
| overdue bills | 0 |
| max overdue days | 0 |
| arrears stage | `NO_OVERDUE` |
| warnings | 2 |

### Evidence Groups

- `denominator`
- `economics`
- `ECONOMICS`
- `EXECUTION_GUARD`
- `RISK`
- `timeline`
- `VEHICLE`

## 9. Safety Confirmation

- Fleet Ops UI is read-only.
- No execution/write controls were reported.
- `EXECUTION_GUARD` appears as diagnostic evidence, not an action control.
- No Fleet Ops write/execute/admin/action permission was enabled.
- No customer/public exposure was reported.

## 10. Known Notes / Gaps

- Selected vehicle has sparse operational/economic history.
- LOW confidence and fallback warnings are expected for this sample.
- OP / GM access smoke still needs explicit production confirmation if not yet tested.
- Non-granted role denial still needs explicit production confirmation if not yet tested.
- Current UI requires manual vehicleId input.
- Follow-up recommended: P1-H23 Fleet Ops Vehicle Selector / Lookup.

## 11. Observation Window

| Field | Value |
| --- | --- |
| Active observation | 2 hours |
| Passive observation | 24 hours |
| Start | `2026-07-05T04:01:24.292Z` Fleet Ops snapshot generatedAt timestamp. Operator start time was not separately provided. |
| Monitor | API 5xx, Web 5xx, unexpected authorized-role 403, unauthorized access, `/fleet-ops` load failures, operator feedback. |

## 12. Rollback

Rollback steps:

1. Set `FLEET_OPS_API_ENABLED=false`.
2. Recreate/restart API with the same image.
3. If app-level rollback is required, restore the previous API/Web images:
   - API rollback image: `ghcr.io/keqi119/subscription-api:fadada-main-20260629-48dc98d`.
   - Web rollback image: `ghcr.io/keqi119/subscription-web:portal-rc-r3-20260620-1355c85`.
4. DB rollback is separate and requires DB owner review.
5. Permission/menu entries may remain.

## 13. Conclusion

Conclusion: `PASS_WITH_NOTES`

PASS reasons:

- Production images aligned.
- DB schema up to date.
- Access sync completed.
- Feature flag enabled.
- API health OK.
- Fleet Ops page generated snapshot.
- State, timeline, economics, risk, and evidence rendered.

NOTES:

- Selected vehicle has sparse data and LOW confidence.
- Timeline fallback warning is expected.
- OP/GM and non-granted role smoke may still need explicit confirmation.
- Vehicle selector/lookup should be implemented in P1-H23.
