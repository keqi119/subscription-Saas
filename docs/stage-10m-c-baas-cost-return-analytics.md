# Stage 10M-C-B BaaS Cost Return Analytics

Stage 10M-C-B was the intermediate step that exposed BaaS battery leasing costs in asset profitability analysis before the main formula switch.

Stage 10M-C-C has superseded this supplemental-only stage. The active reporting standard is now:

```text
docs/stage-10m-c-baas-cost-main-return-metrics.md
```

## Historical Scope

10M-C-B added read-only BaaS cost visibility to:

- Asset return summary.
- Vehicle return list.
- Vehicle return detail.
- CSV exports.

It did not generate bills, payment records, write-offs, supplier payment orders, accounting entries, or customer-facing flow changes.

## Current Status

Starting in Stage 10M-C-C, BaaS costs are no longer treated as a separate page-level supplemental result. They are included directly in the main asset profitability metrics:

```text
platformNetIncomeAmount
roeTrial
annualizedRoeTrial
trialRoa
```

The page keeps its existing core result layout. BaaS appears as:

- A cost item in `成本与资本结构拆解`.
- A contract-status column after `车辆状态` in `单车收益试算列表`.
- A cost column before `经营成本` in `单车收益试算列表`.

Use the 10M-C-C document for all current calculation, CSV, and manual acceptance references.
