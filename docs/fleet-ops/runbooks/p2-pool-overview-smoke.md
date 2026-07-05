# Fleet Ops P2 Pool Overview Smoke Runbook

## 1. Purpose And Scope

This runbook validates the P2 Fleet Ops pool overview experience after the P2-H2 backend and P2-H3 frontend have been deployed by an operator.

It covers:

- API smoke for the pool overview GET endpoints.
- Web smoke for the single-vehicle diagnostic, overview, pool list, and pool detail routes.
- Role, permission, and feature flag behavior.
- Read-only safety checks.
- Pool, cohort, metric, anomaly, and drilldown calibration.
- Observation, disable, rollback, and follow-up decision criteria.

This runbook does not execute production actions by itself. Codex must not run production commands, query production databases, run access sync, deploy, restart services, or change feature flags. Operators execute any environment-specific commands manually and paste redacted evidence into the calibration record.

## 2. Preconditions

Before starting smoke, confirm:

- Target branch, commit SHA, API image, and Web image are captured.
- API and Web were deployed by the operator through the approved deployment process.
- Database migrations are up to date, or the migration preflight record explains why no migration is required.
- Fleet Ops access sync has already completed for `fleet_ops:read` if the target environment needs it.
- Expected `FLEET_OPS_API_ENABLED` value is known before smoke begins.
- Test accounts are available for `ADMIN`, `OP`, `GM`, and at least one non-granted internal role when possible.
- Sample data is available, or sparse-data limitations are recorded.
- No secrets, raw DSNs, tokens, cookies, passwords, or customer personal data will be copied into the evidence record.

## 3. Release Identity Capture

Record these fields in `docs/fleet-ops/runbooks/p2-pool-overview-calibration-record.md`:

- Environment: staging or production.
- Branch.
- Commit SHA.
- API image tag and digest.
- Web image tag and digest.
- Database target alias, not the raw connection string.
- Operator.
- Reviewer.
- Smoke start time and timezone.
- `FLEET_OPS_API_ENABLED` expected value.
- `fleet_ops:read` role access scope.

## 4. Non-Live Verification Before Manual Smoke

Run these non-live gates before environment smoke:

```bash
pnpm --filter @subscription-saas/api test:fleet-ops
pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-pool-api.spec.ts test/fleet-ops-pool-view-model.spec.ts test/fleet-ops-pool-overview.spec.ts test/fleet-ops-pool-readonly.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-readonly.spec.ts test/fleet-ops-view-model.spec.ts test/fleet-ops-vehicle-lookup.spec.ts
```

Optional focused API contract regression:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/fleet-ops.api-contract.spec.ts test/fleet-ops.pool-aggregation.spec.ts test/fleet-ops.pool-readonly.spec.ts
```

## 5. API Smoke Checklist

Operator-only placeholders:

```bash
curl "<API_BASE>/api/fleet-ops/health?requestId=p2-h4-smoke"
curl "<API_BASE>/api/fleet-ops/overview?scopeType=ALL&topN=10"
curl "<API_BASE>/api/fleet-ops/pools?page=1&pageSize=20"
curl "<API_BASE>/api/fleet-ops/pools/<POOL_ID>?topN=10"
curl "<API_BASE>/api/fleet-ops/overview/vehicles?scopeType=POOL&poolId=<POOL_ID>&page=1&pageSize=20"
curl "<API_BASE>/api/fleet-ops/vehicles/lookup?q=<VIN_OR_VEHICLE_NO>&limit=10"
```

For each endpoint, record:

- HTTP status.
- Whether the response is JSON and matches the expected contract shape.
- Whether `FLEET_OPS_API_ENABLED=false` returns the existing disabled behavior when tested in a controlled environment.
- Whether permission denial works for a non-granted role.
- Whether response data excludes full evidence payloads, customer personal data, full VINs, and full plates where applicable.
- Whether any warning explains sparse data, deferred metrics, or too-large scope behavior.

Redact authorization headers, cookies, tokens, account identifiers, raw vehicle owner data, and customer personal data.

## 6. Web Route Smoke Checklist

Smoke these routes:

- `/fleet-ops`
- `/fleet-ops?vehicleId=<id>`
- `/fleet-ops/overview`
- `/fleet-ops/pools`
- `/fleet-ops/pools/[poolId]`

For each route, record:

- Loaded, disabled, denied, empty, or failed.
- Page title and key section observed.
- Screenshot reference or textual observation.
- Current role.
- Feature flag expectation.
- Any error, warning, or too-large scope message.
- Confirmation that no write, execution, saved-view, or batch action control appears.

Expected route behavior:

- `/fleet-ops` remains the single-vehicle diagnostic entry.
- `/fleet-ops?vehicleId=<id>` opens the existing single-vehicle snapshot.
- `/fleet-ops/overview` shows the pool/cohort overview.
- `/fleet-ops/pools` shows formal pool list data or an empty state.
- `/fleet-ops/pools/[poolId]` shows pool identity, pool-scoped metrics, anomalies, and vehicle drilldown links.

## 7. Role And Access Smoke

Expected role behavior:

- `ADMIN` with `fleet_ops:read`: pass.
- `OP` with `fleet_ops:read`: pass.
- `GM` with `fleet_ops:read`: pass.
- Non-granted internal role: denied or menu hidden.
- Customer/public route: not exposed.

Record for each role:

- `/auth/me` or equivalent role/access observation.
- `/fleet-ops` result.
- `/fleet-ops/overview` result.
- `/fleet-ops/pools` result.
- A representative API endpoint result.
- Denial or disabled text, if applicable.

## 8. Feature Flag Smoke

When `FLEET_OPS_API_ENABLED=true`:

- API overview and pool endpoints return normal data, empty data, or documented warnings.
- Web routes render data, empty states, or warning states.
- Existing single-vehicle diagnostic remains available to granted roles.

When `FLEET_OPS_API_ENABLED=false` in a controlled operator-approved test:

- API endpoints return the existing disabled state.
- Web routes render the existing disabled state.
- No operator should toggle production flags only for curiosity. Codex must not change feature flags.

## 9. Read-Only Safety Smoke

Confirm the UI does not show:

- 保存视图
- 批量操作
- 执行动作
- 催收动作
- 分配车辆
- 激活租赁
- 触发维修
- 限制车辆
- Create, edit, delete, archive, or save pool controls.
- Add or remove vehicle controls.
- POST, PATCH, PUT, or DELETE interaction paths.
- Customer/public Fleet Ops links.

Confirm the API smoke does not reveal:

- Mutation endpoints under `/fleet-ops`.
- Execution/action endpoints under `/fleet-ops`.
- Saved custom view persistence endpoints.
- Customer/public exposure.

## 10. Sample Selection

Select samples in this order:

- At least one active `VehicleAssetPool` with active vehicle membership.
- At least one dynamic cohort using a safe combination of brand, model, status, or asset location.
- At least one vehicle with known revenue/cost facts, if available.
- At least one vehicle with overdue exposure, if available.
- At least one low-confidence or warning-heavy vehicle, if available.
- If production data is sparse, record the limitation and validate empty/sparse states rather than inventing data.

Record:

- Pool ID and pool display name.
- Cohort filters.
- Vehicle IDs used for drilldown.
- Selected `asOf`, `from`, and `to` values.
- Timezone and tolerance notes.

## 11. Metric Calibration Checklist

Use sample-based calibration. Do not require perfect manual recalculation for every row.

For each selected pool or cohort, record:

- Total vehicles.
- Active / operating vehicles.
- Idle / available vehicles.
- Abnormal vehicles.
- Overdue vehicles.
- Missing data / low-confidence vehicles.
- Revenue.
- Cost.
- Net income.
- ROI.
- ROE.
- Denominator evidence.
- Actual operating cashflow.
- Actual deposit cashflow.
- Planned operating cashflow.
- Planned deposit cashflow.
- Unallocated cashflow.
- Overdue amount.
- Overdue vehicle count.
- Overdue bill count.
- Max overdue days.
- D1-D5 aging distribution.
- Average confidence.
- Minimum confidence.
- Warning count.
- Missing evidence count.
- Timeline fallback count.

Calibration method:

- Compare pool/cohort totals to selected single-vehicle drilldowns where practical.
- Verify formula directionality and obvious outliers.
- Record `asOf`, date range, timezone, and filters before comparing numbers.
- Record tolerance and unresolved differences.
- Treat low confidence as a data quality signal, not an automatic smoke failure.

## 12. Required Metric Semantics

Confirm:

- ROI and ROE are total-based pool/cohort metrics, not a simple average of vehicle ratios.
- Deposits are shown separately and excluded from operating revenue.
- Overdue facts use `dueDate < asOfDate`, `remainingAmount > 0`, and `billStatus != CANCELLED`.
- D1-D5 buckets use: D1 1-3, D2 4-7, D3 8-15, D4 16-30, D5 >30.
- Confidence is presented as average, minimum, distribution, and low-confidence count where available.
- Evidence is summarized at pool/cohort level; full evidence stays in single-vehicle drilldown.

## 13. Anomaly And Drilldown Validation

Review these anomaly lists:

- Highest overdue exposure.
- Highest risk.
- Lowest ROI.
- Lowest confidence.
- Missing evidence.
- Cashflow anomaly.
- Timeline fallback.

For each list:

- Confirm the list renders, shows an empty state, or shows a documented deferred/unavailable warning.
- Confirm top-N limits are respected.
- Confirm rows identify the vehicle without exposing sensitive customer data.
- Confirm `查看单车快照` opens `/fleet-ops?vehicleId=<id>`.
- Confirm the opened single-vehicle snapshot matches the selected vehicle.
- Confirm anomaly lists are not presented as execution queues or task assignment lists.

## 14. Observation Window

Recommended observation:

- Staging: one full smoke pass plus reviewer sign-off.
- Production active observation: first 2 hours after enablement or deployment.
- Production passive observation: 24 hours after active observation.

Monitor:

- API error rate and latency for Fleet Ops routes.
- Web route load failures.
- Feature flag disabled errors.
- Permission denied regressions.
- Too-large scope responses.
- Operator feedback about metric clarity.
- Any evidence of write/action controls.

## 15. Rollback Or Disable Plan

Operator-only options:

- Set `FLEET_OPS_API_ENABLED=false` and recreate/restart API through the approved operator process.
- Keep the UI deployed; the UI should render the disabled state when API is disabled.
- Roll back API and Web images together if the issue is image or code related.
- Keep DB unchanged unless a DB owner separately approves a DB rollback plan.
- Do not run access sync as part of P2-H4 smoke unless a later human-controlled enablement task explicitly requires it.

Codex must not execute rollback, restart services, change flags, query production DB, or deploy images.

## 16. Result Classification

- `PASS`: all required route/API/role/read-only smoke passes, metric calibration has no unresolved material issue, and observation has no blocker.
- `PASS_WITH_NOTES`: smoke passes, but sparse data, minor copy clarity, non-blocking calibration differences, or follow-up UX notes remain.
- `NO_GO`: pre-enable or pre-release smoke finds a material route, permission, feature flag, readonly, or metric correctness issue.
- `ROLLBACK_REQUIRED`: production rollout creates material user impact, unsafe behavior, severe contract mismatch, or unverifiable metric exposure requiring disablement or image rollback.

## 17. P2-H5 Decision Framework

Open P2-H5 follow-up when smoke evidence shows:

- Metric labels or explanation need correction.
- ROI/ROE, deposit, overdue, or D1-D5 semantics need calibration.
- Empty, sparse, or too-large scope states confuse operators.
- Anomaly ranking needs threshold tuning.
- Role or disabled-state behavior needs hardening.
- Documentation, tests, or acceptance evidence need tightening.

## 18. P3 Saved Custom View Deferral

Saved custom views remain deferred until P2 evidence proves dynamic filters are insufficient.

P3 must be planned separately because saved views require:

- Write scope.
- Ownership and sharing rules.
- Audit behavior.
- Permission design.
- Persistence lifecycle.
- Deletion and retention policy.

## 19. Completed Records

- `docs/fleet-ops/runbooks/p2-pool-overview-calibration-record-20260705.md`: production smoke and metric calibration completed as `PASS_WITH_NOTES` on 2026-07-05.
