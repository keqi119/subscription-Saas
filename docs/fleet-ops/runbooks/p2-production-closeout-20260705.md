# Fleet Ops P2 Production Closeout - 2026-07-05

Status: `PASS_WITH_NOTES`

## 1. Purpose And Scope

This document closes out Fleet Ops P2 after production smoke and metric calibration.

It is based on the P2-H4 production smoke record:

- `docs/fleet-ops/runbooks/p2-pool-overview-calibration-record-20260705.md`

This closeout is documentation-only. It does not introduce runtime changes, execute production actions, deploy images, query production databases, run access sync, change feature flags, or start P3 saved custom views.

## 2. P2 Delivery Summary

- P2-H1: Pool overview and dynamic cohort design.
- P2-H2: Backend read-only pool overview aggregation.
- P2-H3: Frontend pool overview UI.
- P2-H4: Smoke/calibration runbook and completed production smoke record.
- P2-H5: Production closeout and hardening decision.

## 3. Production Evidence Reference

Production smoke evidence is recorded in:

- `docs/fleet-ops/runbooks/p2-pool-overview-calibration-record-20260705.md`

Evidence summary:

| Field | Value |
| --- | --- |
| Environment | production |
| Operator | Ke Li |
| Timestamp | 2026-07-05 22:42 Asia/Shanghai |
| Commit | `aa8dc89f28a7904d7e0608a0746e15fe9bd051ff` |
| API image | `ghcr.io/keqi119/subscription-api:prod-20260705-aa8dc89` |
| Web image | `ghcr.io/keqi119/subscription-web:prod-20260705-aa8dc89` |
| `FLEET_OPS_API_ENABLED` | `true` |

## 4. P2-H4 Production Result

Final classification: `PASS_WITH_NOTES`

PASS items:

- `/fleet-ops` loads.
- `/fleet-ops?vehicleId=<id>` loads the single-vehicle snapshot.
- `/fleet-ops/overview` loads.
- `/fleet-ops/pools` loads.
- `/fleet-ops/pools/[poolId]` loads.
- `ADMIN`, `OP`, and `GM` can access.
- Non-granted internal role is denied as expected.
- Customer/public access is denied as expected.
- Read-only safety passed.
- Anomaly drilldown works.
- ROI/ROE total-based semantics were confirmed.
- Deposits are separated from operating revenue.
- Overdue and D1-D5 states were observed.
- Confidence and warnings were explainable.

NOTES:

- Raw numeric revenue/cost/net income values were observed but not pasted.
- D1-D5 was `EMPTY_EXPECTED` because the sample had no overdue amount.
- Passive observation completion remains pending unless later evidence is added.
- Broad/default dynamic cohort sample should be followed by more targeted cohort samples if operators need deeper calibration.

## 5. Runtime Hardening Decision

No immediate runtime change is recommended.

Reason:

- No route failure was reported.
- No role failure was reported.
- No feature flag failure was reported.
- No read-only safety failure was reported.
- No customer/public exposure was reported.
- No metric semantics failure was reported.
- No anomaly drilldown failure was reported.

## 6. UI/Copy Hardening Decision

No immediate UI/copy hardening is required.

Current UI/copy is sufficient for:

- ROI/ROE total-based pool/cohort aggregation.
- Deposits excluded from operating revenue.
- D1-D5 no-overdue / `EMPTY_EXPECTED` behavior.
- Low confidence as a data-quality signal.
- Anomaly lists as diagnostic drilldown lists, not execution queues.
- Dynamic cohort as temporary analysis scope.

Future hardening may be opened if operators report confusion.

## 7. Test Hardening Decision

No immediate test-only hardening is required.

Existing tests cover:

- GET-only API helpers.
- Read-only UI guard.
- No saved-view, batch, or execution controls.
- ROI/ROE label semantics.
- Deposit copy.
- D1-D5 labels.
- Confidence labels.
- Anomaly drilldown href.
- Backend total-based ROI/ROE and deposit separation.

Future tests may be opened only for repeated smoke gaps.

## 8. P2 Sufficiency Decision

Fleet Ops P2 is sufficient for continued controlled internal management use and observation.

This closeout does not claim Fleet Ops P2 is complete for every future management need.

P2 currently supports:

- Pool overview.
- Formal vehicle pool list/detail.
- Broad/default dynamic cohort scope.
- KPI/risk/cashflow/data-quality summary.
- Anomaly vehicle drilldown.
- Single-vehicle diagnostic investigation.

P2 sufficiency for broader daily management should continue to be evaluated through operator feedback.

## 9. P2-H6 Trigger Criteria

Open P2-H6 only if one or more conditions occur:

- Passive observation reports route/API errors.
- Operators report metric wording confusion.
- Raw numeric metric calibration shows mismatch.
- D1-D5 empty/no-overdue state causes confusion.
- Anomaly ranking does not match operating intuition.
- Targeted dynamic cohort calibration is requested.
- Too-large or sparse-data UX becomes confusing.
- Additional role/feature flag regression is found.
- A repeated smoke gap should be guarded by tests.

Potential P2-H6 types:

- Docs-only operator guide.
- Frontend copy hardening.
- Empty/sparse-data UX hardening.
- Anomaly ranking tuning.
- Test-only hardening.
- Production observation addendum.

## 10. P3 Saved Custom View Deferral

P3 saved custom views remain deferred.

Do not start P3 unless operators explicitly report:

- Repeated need to save/share named filter sets.
- Dynamic cohort filters are insufficient without persistence.
- Team ownership or shared view workflow is required.
- Audit and lifecycle requirements are understood.
- Write scope and permissions are approved separately.

## 11. Rollback / Disable Status

No rollback is required.

No feature flag disable is required.

Keep the existing safety path:

- Operator can set `FLEET_OPS_API_ENABLED=false`.
- API restart/recreate is operator-controlled.
- UI should render the disabled state.
- Image rollback requires the approved release process.
- DB rollback is separate and requires DB owner review.

## 12. Final Closeout Classification

Final classification: `PASS_WITH_NOTES`

Reason:

P2 is production-smoked and safe for controlled internal management use, but passive observation and raw numeric metric evidence remain incomplete.

## 13. Appendix: Safety And Redaction

- Do not paste secrets.
- Do not paste raw DB URLs.
- Do not paste tokens or passwords.
- Avoid customer personal data.
- Redact sensitive vehicle/customer fields where unnecessary.
