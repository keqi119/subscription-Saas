# Fleet Ops P2 Pool Overview Calibration Record - 2026-07-05

Status: `PASS_WITH_NOTES`

This record preserves operator-provided production smoke and calibration evidence for the P2 Fleet Ops pool overview experience. It does not execute production actions by itself.

## 1. Record Metadata

| Field | Value |
| --- | --- |
| Status | `PASS_WITH_NOTES` |
| Environment | production |
| Operator | Ke Li |
| Reviewer | TBD |
| Operator timestamp | 2026-07-05 22:42 Asia/Shanghai |
| Started at | 2026-07-05 22:42 Asia/Shanghai, operator timestamp; exact start split not provided |
| Completed at | 2026-07-05 22:42 Asia/Shanghai, operator timestamp; exact completion split not provided |
| Active observation window | 2 hours; status TBD unless operator later records completion evidence |
| Passive observation window | 24 hours; status TBD unless operator later records completion evidence |

## 2. Release Identity

| Field | Value |
| --- | --- |
| Deployment commit SHA | `aa8dc89f28a7904d7e0608a0746e15fe9bd051ff` |
| Short SHA | `aa8dc89` |
| API image | `ghcr.io/keqi119/subscription-api:prod-20260705-aa8dc89` |
| API imageId | `sha256:ed3a87515b117a0ff17af22a145c43eb0fb71d5dee76ad4341620cf5872a8cbd` |
| Web image | `ghcr.io/keqi119/subscription-web:prod-20260705-aa8dc89` |
| Web imageId | `sha256:06e222753eeefdac2d2e949a3f5afa144f1fcf1171e176aa82d6b96a5e4c8afe` |
| `FLEET_OPS_API_ENABLED` | `true` |
| Database target alias | `prod-primary`, not reconfirmed by Codex |

No secrets, raw DB URL, tokens, passwords, or customer personal data are included in this record.

## 3. Automated Verification

This evidence record is based on manual production smoke results provided by the operator.

Non-live verification performed during this docs-only record task:

| Gate | Command | Result | Evidence summary |
| --- | --- | --- | --- |
| API Fleet Ops RC gate | `pnpm --filter @subscription-saas/api test:fleet-ops` | PASS | 40 test files passed; 156 tests passed. |
| Web Fleet Ops focused tests | `pnpm --filter @subscription-saas/web exec vitest run test/fleet-ops-pool-api.spec.ts test/fleet-ops-pool-view-model.spec.ts test/fleet-ops-pool-overview.spec.ts test/fleet-ops-pool-readonly.spec.ts test/fleet-ops-api.spec.ts test/fleet-ops-readonly.spec.ts test/fleet-ops-view-model.spec.ts test/fleet-ops-vehicle-lookup.spec.ts` | PASS | 8 test files passed; 37 tests passed. |
| Optional API contract regression | `pnpm --filter @subscription-saas/api exec vitest run test/fleet-ops.api-contract.spec.ts test/fleet-ops.pool-aggregation.spec.ts test/fleet-ops.pool-readonly.spec.ts` | PASS | 3 test files passed; 7 tests passed. |

## 4. API Smoke Evidence

Route-level and UI-level production smoke were completed by operator; raw API curl outputs were not pasted into this record.

Endpoints covered by the P2-H4 smoke scope:

| Endpoint | Scope | Result | Notes |
| --- | --- | --- | --- |
| `GET /fleet-ops/health` | Health | Operator smoke scope covered | Raw curl output not pasted. |
| `GET /fleet-ops/overview` | Overview | Operator smoke scope covered | `/fleet-ops/overview` UI opened and KPI list was visible. |
| `GET /fleet-ops/pools` | Pool list | Operator smoke scope covered | `/fleet-ops/pools` UI opened and list displayed normally. |
| `GET /fleet-ops/pools/:poolId` | Pool detail | Operator smoke scope covered | Detail tested with pool `VPOOL20260705145044D7C8`. |
| `GET /fleet-ops/overview/vehicles` | Scoped vehicle list | Operator smoke scope covered | Raw API output not pasted. |
| `GET /fleet-ops/vehicles/lookup` | Vehicle lookup | PASS | Vehicle lookup worked on `/fleet-ops`. |

## 5. Web Route Smoke Evidence

| Route | Result | Observation | Notes |
| --- | --- | --- | --- |
| `/fleet-ops` | PASS | Single-vehicle diagnostic opens and vehicle lookup works. | Operator-confirmed. |
| `/fleet-ops?vehicleId=b02dcb46-8f35-4abc-8e0d-6e90d5b091e1` | PASS | Single-vehicle snapshot opens. | Operator-confirmed. |
| `/fleet-ops/overview` | PASS | Fleet Ops overview opens and KPI list is visible. | Operator-confirmed. |
| `/fleet-ops/pools` | PASS | Vehicle pool list opens; list displays normally; detail is reachable. | Operator-confirmed. |
| `/fleet-ops/pools/[poolId]` | PASS_WITH_NOTES | Pool detail tested with poolId `VPOOL20260705145044D7C8`. | Operator did not paste a separate detail screenshot or raw output. |

## 6. Role Matrix

| Role | Expected | Result | Notes |
| --- | --- | --- | --- |
| ADMIN | Accessible | PASS | Operator-confirmed. |
| OP | Accessible | PASS | Operator-confirmed. |
| GM | Accessible | PASS | Operator-confirmed. |
| Non-granted internal role | Denied or menu hidden | DENIED_EXPECTED | Menu hidden or 403. |
| Customer/public | No entry or inaccessible | DENIED_EXPECTED | No entry or inaccessible. |

## 7. Read-Only Safety Evidence

Result: `PASS`

No controls were observed for:

- 保存视图
- 批量操作
- 执行动作
- 催收动作
- 分配车辆
- 激活租赁
- 触发维修
- 限制车辆
- 创建车辆池
- 编辑车辆池
- 删除车辆池

No Fleet Ops write, execution, saved-view, batch operation, or customer/public control was reported.

## 8. Sample Selection

### Formal Pool Sample

| Field | Value |
| --- | --- |
| poolId / poolNo | `VPOOL20260705145044D7C8` |
| poolName | `fleet_ops_test_1` |
| activeVehicleCount | `2` |

Note: an earlier discussion identified `OPERATION` as a likely pool type value, not a vehicle count. This completed record uses the final operator-provided `activeVehicleCount=2` and preserves the field ambiguity as a non-blocking note.

### Dynamic Cohort Sample

| Filter | Value |
| --- | --- |
| brand | 无 |
| model | 无 |
| vehicleStatus | 无 |
| assetLocation | 无 |

Note: no material filter values were applied; this behaves like a broad/default cohort scope. A future P2-H5 or follow-up smoke pass may add one filtered cohort sample if operators need stronger cohort-specific evidence.

### Vehicle Samples

- `5e354d25-41ce-4432-9fc5-ea70e49a1b40`
- `16b4eae7-1106-44e6-b331-80c965f16f68`
- `b02dcb46-8f35-4abc-8e0d-6e90d5b091e1`

## 9. Metric Calibration

| Metric | Result | Notes |
| --- | --- | --- |
| Vehicle counts | PASS | Overview counts are directionally consistent with pool/detail/list. |
| Revenue / cost / net income | PASS | Operator observed values; raw numeric values were not pasted. |
| ROI / ROE | PASS | Confirmed pool/cohort total-based aggregation, not simple average of single-vehicle ROI. |
| Deposit | PASS | Deposits are shown separately and not counted as operating revenue. |
| Overdue | PASS_WITH_NOTES | Overdue amount, vehicle count, and bill count were observed; raw values were not pasted. |
| D1-D5 | PASS_WITH_NOTES | Aging distribution appears reasonable; no overdue amount in the sample is treated as `EMPTY_EXPECTED`. |
| Confidence | PASS | Average/min confidence, warnings, and missing evidence are explainable. |
| Anomaly drilldown | PASS | Anomaly drilldown opens the single-vehicle diagnostic page. |

## 10. Metric Semantics Confirmation

| Semantics check | Result | Notes |
| --- | --- | --- |
| ROI/ROE are total-based, not simple average | PASS | Operator-confirmed. |
| Deposits shown separately | PASS | Operator-confirmed. |
| Deposits excluded from operating revenue | PASS | Operator-confirmed. |
| Overdue follows due date, remaining amount, and non-cancelled status | PASS_WITH_NOTES | Semantics accepted; raw numeric values were not pasted. |
| D1-D5 labels match design | PASS_WITH_NOTES | No overdue amount in sample; empty state expected. |
| Confidence shown as data-quality signal | PASS | Warnings and missing evidence were explainable. |
| Full evidence details remain in single-vehicle drilldown | PASS | Drilldown opened single-vehicle diagnostic. |

## 11. Anomaly Validation

| Check | Result | Notes |
| --- | --- | --- |
| Anomaly drilldown | PASS | Drilldown opens single-vehicle diagnostic page. |
| Drilldown target | PASS | Target is `/fleet-ops?vehicleId=<id>`. |
| Single-vehicle diagnostic opened | PASS | Operator-confirmed. |
| Anomaly list is not an execution queue | PASS | No execution/action controls observed. |
| Raw top-row values pasted | NOT_PROVIDED | Raw top-row values were not pasted into this record. |

## 12. Data Quality And Warnings

- Confidence values were explainable.
- Warnings and missing evidence were visible where applicable.
- Low-confidence or warning-heavy data is treated as a data-quality note, not an automatic failure.
- No blocking data-quality defect was reported.

## 13. Operator Feedback

| Topic | Feedback | Follow-up |
| --- | --- | --- |
| Useful surfaces | Pool overview, KPI list, pool list/detail, anomaly drilldown | Continue observation. |
| Confusing areas | None reported | No immediate correction. |
| Missing filters | None reported | Dynamic cohort filter values were not materially exercised. |
| Metric trust | PASS_WITH_NOTES | Raw numeric values were not pasted; keep as note. |
| P2 sufficient for current management need | Unclear / pending observation | Decide in P2-H5 after passive observation or operator feedback. |

## 14. Observation Log

| Timestamp | Source | Observation | Severity | Owner | Action | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-07-05 22:42 Asia/Shanghai | Operator smoke | P2 pool overview production smoke completed. | info | Ke Li | Continue observation. | open / pending passive observation |

## 15. Rollback Or Disable Decision

| Question | Answer |
| --- | --- |
| Rollback needed | No |
| Disable `FLEET_OPS_API_ENABLED` needed | No |
| Reason | Key routes passed; no write/execution/customer exposure was reported. |
| Owner | Ke Li |
| Action taken by operator | None |
| Verification after disable/rollback | Not applicable |

## 16. Final Classification

Final classification: `PASS_WITH_NOTES`

PASS reasons:

- Core routes loaded.
- ADMIN / OP / GM accessible.
- Non-granted internal role and customer/public access denied as expected.
- Overview, pool list, and pool detail were visible.
- Single-vehicle drilldown works.
- ROI/ROE, deposit, confidence, and anomaly drilldown semantics were validated.
- Read-only safety passed.

NOTES:

- Raw numeric metric values were not pasted.
- Pool detail evidence is route-level/operator observation.
- Earlier `activeVehicleCount` field ambiguity is preserved as a note; final operator-provided count is `2`.
- Overdue/D1-D5 is `PASS_WITH_NOTES` with `EMPTY_EXPECTED` for no-overdue sample behavior.
- Active and passive observation completion is not yet recorded.

Required P2-H5 follow-up:

- Decide whether P2-H5 should be production hardening/release record, metric label correction, sparse-data UX refinement, or anomaly ranking tuning after passive observation.
- Do not start immediate P3 saved custom view planning.

P3 saved view decision: `deferred`

## 17. Appendix: Redaction Rule

- Do not paste secrets.
- Do not paste raw DB URLs.
- Do not paste passwords, tokens, cookies, or registry credentials.
- Avoid customer personal data.
- Redact sensitive vehicle/customer fields where unnecessary.
