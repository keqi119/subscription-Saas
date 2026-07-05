# Fleet Ops P2 Pool Overview Calibration Record

Status: `PENDING`

Allowed final statuses: `PENDING`, `PASS`, `PASS_WITH_NOTES`, `NO_GO`, `ROLLBACK_REQUIRED`.

Do not record secrets, raw DB URLs, passwords, tokens, cookies, registry credentials, customer personal data, full VINs, full plates, or unredacted authorization headers.

## 1. Record Metadata

| Field | Value |
| --- | --- |
| Environment | TBD |
| Operator | TBD |
| Reviewer | TBD |
| Started at | TBD |
| Completed at | TBD |
| Active observation window | TBD |
| Passive observation window | TBD |
| Final status | PENDING |

## 2. Release Identity

| Field | Value |
| --- | --- |
| Branch | TBD |
| Commit SHA | TBD |
| API image tag | TBD |
| API image digest | TBD |
| Web image tag | TBD |
| Web image digest | TBD |
| Database target alias | TBD |
| `FLEET_OPS_API_ENABLED` expected value | TBD |
| `fleet_ops:read` access scope | TBD |

## 3. Automated Verification

| Gate | Command | Result | Evidence summary |
| --- | --- | --- | --- |
| API Fleet Ops RC gate | `pnpm --filter @subscription-saas/api test:fleet-ops` | TBD | TBD |
| Web Fleet Ops focused tests | `pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-pool-api.spec.ts test/fleet-ops-pool-view-model.spec.ts test/fleet-ops-pool-overview.spec.ts test/fleet-ops-pool-readonly.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-readonly.spec.ts test/fleet-ops-view-model.spec.ts test/fleet-ops-vehicle-lookup.spec.ts` | TBD | TBD |
| Optional API contract regression | `pnpm --filter @subscription-saas/api exec vitest run test/fleet-ops.api-contract.spec.ts test/fleet-ops.pool-aggregation.spec.ts test/fleet-ops.pool-readonly.spec.ts` | TBD | TBD |

## 4. API Smoke Evidence

| Endpoint | Scope | HTTP status | Result | Notes |
| --- | --- | --- | --- | --- |
| `GET /fleet-ops/health` | Health | TBD | TBD | TBD |
| `GET /fleet-ops/overview` | Overview | TBD | TBD | TBD |
| `GET /fleet-ops/pools` | Pool list | TBD | TBD | TBD |
| `GET /fleet-ops/pools/:poolId` | Pool detail | TBD | TBD | TBD |
| `GET /fleet-ops/overview/vehicles` | Scoped vehicle list | TBD | TBD | TBD |
| `GET /fleet-ops/vehicles/lookup` | Vehicle lookup | TBD | TBD | TBD |

## 5. Web Route Smoke Evidence

| Route | Role | Result | Observation | Screenshot or note |
| --- | --- | --- | --- | --- |
| `/fleet-ops` | TBD | TBD | Single-vehicle diagnostic route | TBD |
| `/fleet-ops?vehicleId=<id>` | TBD | TBD | Single-vehicle snapshot drilldown | TBD |
| `/fleet-ops/overview` | TBD | TBD | Pool/cohort overview route | TBD |
| `/fleet-ops/pools` | TBD | TBD | Formal pool list route | TBD |
| `/fleet-ops/pools/[poolId]` | TBD | TBD | Pool detail route | TBD |

## 6. Role Matrix

| Role | `fleet_ops:read` expected | `/fleet-ops` | `/fleet-ops/overview` | `/fleet-ops/pools` | API endpoint | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ADMIN | Yes | TBD | TBD | TBD | TBD | TBD |
| OP | Yes | TBD | TBD | TBD | TBD | TBD |
| GM | Yes | TBD | TBD | TBD | TBD | TBD |
| Non-granted internal role | No | TBD | TBD | TBD | TBD | TBD |
| Customer/public | No exposure | TBD | TBD | TBD | TBD | TBD |

## 7. Read-Only Safety Evidence

| Check | Result | Notes |
| --- | --- | --- |
| No saved-view control | TBD | Must not show 保存视图 |
| No batch operation control | TBD | Must not show 批量操作 |
| No execution/action control | TBD | Must not show 执行动作 |
| No collection action control | TBD | Must not show 催收动作 |
| No assign vehicle control | TBD | Must not show 分配车辆 |
| No activate lease control | TBD | Must not show 激活租赁 |
| No repair trigger control | TBD | Must not show 触发维修 |
| No restrict vehicle control | TBD | Must not show 限制车辆 |
| No create/edit/delete pool control | TBD | No pool mutation UI |
| No add/remove vehicle control | TBD | No pool membership mutation UI |
| No POST/PATCH/PUT/DELETE Fleet Ops UI path | TBD | GET-only UI behavior |
| No customer/public exposure | TBD | Internal/admin only |

## 8. Sample Selection

| Sample | Selected value | Why selected | Notes |
| --- | --- | --- | --- |
| Formal active pool | TBD | Active `VehicleAssetPool` with active membership | TBD |
| Dynamic cohort | TBD | Brand/model/status/location filters | TBD |
| Vehicle with revenue/cost | TBD | Economics calibration | TBD |
| Vehicle with overdue exposure | TBD | Risk calibration | TBD |
| Low-confidence or warning-heavy vehicle | TBD | Data quality calibration | TBD |
| Sparse-data fallback | TBD | Empty/sparse-state validation | TBD |

## 9. Metric Calibration

| Scope | Metric | API value | UI value | Sample comparison | Tolerance | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pool/cohort | total vehicles | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | active / operating vehicles | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | idle / available vehicles | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | abnormal vehicles | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | overdue vehicles | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | missing data / low-confidence vehicles | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | revenue | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | cost | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | net income | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | ROI | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | ROE | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | denominator evidence | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | actual operating cashflow | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | actual deposit cashflow | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | planned operating cashflow | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | planned deposit cashflow | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | unallocated cashflow | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | overdue amount | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | overdue vehicle count | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | overdue bill count | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | max overdue days | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | D1-D5 aging distribution | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | average confidence | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | minimum confidence | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | warning count | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | missing evidence count | TBD | TBD | TBD | TBD | TBD | TBD |
| Pool/cohort | timeline fallback count | TBD | TBD | TBD | TBD | TBD | TBD |

## 10. Metric Semantics Confirmation

| Semantics check | Result | Notes |
| --- | --- | --- |
| ROI is total net income divided by total invested capital, not simple average | TBD | TBD |
| ROE is total net income divided by total equity base, not simple average | TBD | TBD |
| Deposits are shown separately | TBD | TBD |
| Deposits are excluded from operating revenue | TBD | TBD |
| Overdue uses `dueDate < asOfDate`, `remainingAmount > 0`, and non-cancelled bill status | TBD | TBD |
| D1 is 1-3 days | TBD | TBD |
| D2 is 4-7 days | TBD | TBD |
| D3 is 8-15 days | TBD | TBD |
| D4 is 16-30 days | TBD | TBD |
| D5 is greater than 30 days | TBD | TBD |
| Confidence is treated as data quality context, not a pass/fail metric alone | TBD | TBD |
| Full evidence stays in single-vehicle drilldown | TBD | TBD |

## 11. Anomaly Validation

| Anomaly list | Result | Representative vehicle | Drilldown result | Notes |
| --- | --- | --- | --- | --- |
| Highest overdue exposure | TBD | TBD | TBD | TBD |
| Highest risk | TBD | TBD | TBD | TBD |
| Lowest ROI | TBD | TBD | TBD | TBD |
| Lowest confidence | TBD | TBD | TBD | TBD |
| Missing evidence | TBD | TBD | TBD | TBD |
| Cashflow anomaly | TBD | TBD | TBD | TBD |
| Timeline fallback | TBD | TBD | TBD | TBD |

## 12. Data Quality And Warnings

| Warning or confidence note | Scope | User impact | Decision |
| --- | --- | --- | --- |
| TBD | TBD | TBD | TBD |

## 13. Operator Feedback

| Topic | Feedback | Follow-up |
| --- | --- | --- |
| Metric clarity | TBD | TBD |
| Route clarity | TBD | TBD |
| Pool vs cohort terminology | TBD | TBD |
| Anomaly usefulness | TBD | TBD |
| Empty/sparse-state clarity | TBD | TBD |
| Too-large scope clarity | TBD | TBD |

## 14. Observation Log

| Time | Observer | Event | Severity | Decision |
| --- | --- | --- | --- | --- |
| TBD | TBD | TBD | TBD | TBD |

## 15. Rollback Or Disable Decision

| Question | Answer |
| --- | --- |
| Is `FLEET_OPS_API_ENABLED=false` required? | TBD |
| Is API image rollback required? | TBD |
| Is Web image rollback required? | TBD |
| Is DB owner review required? | TBD |
| Is P2-H5 correction required before further rollout? | TBD |
| Operator decision timestamp | TBD |

## 16. Final Classification

Final status: `PENDING`

Classification criteria:

- `PASS`: smoke and calibration pass without material unresolved issues.
- `PASS_WITH_NOTES`: smoke passes with sparse-data, minor metric-copy, non-blocking calibration, or UX follow-up notes.
- `NO_GO`: pre-release or pre-enable smoke finds a material route, permission, feature flag, readonly, or metric correctness issue.
- `ROLLBACK_REQUIRED`: production smoke finds material user impact, unsafe behavior, severe contract mismatch, or unverifiable metric exposure requiring disablement or rollback.

P2-H5 decision:

- [ ] Not needed yet.
- [ ] Start post-smoke correction.
- [ ] Start production hardening.
- [ ] Start metric calibration refinement.

P3 saved custom view decision:

- [ ] Deferred.
- [ ] Start separate P3 planning.
- [ ] Not needed yet.

## 17. Appendix: Redaction Rule

Evidence may include route names, status codes, timestamps, role names, redacted IDs, metric values, warnings, and screenshot references.

Evidence must not include secrets, raw DB URLs, passwords, tokens, cookies, registry credentials, full VINs, full plates, customer personal data, or unredacted authorization headers.
