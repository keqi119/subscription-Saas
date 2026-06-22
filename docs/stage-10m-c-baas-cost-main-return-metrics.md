# Stage 10M-C-C BaaS Cost Main Return Metrics

Stage 10M-C-C promotes BaaS battery leasing costs from a supplemental return metric to the main asset profitability formula.

From this stage onward, `VehicleBaasCostRecord` costs are included in the main `platformNetIncomeAmount`, `roeTrial`, `annualizedRoeTrial`, and `trialRoa` calculations.

## Why This Changed

Stage 10M-C-B first exposed BaaS costs as a separate analytics dimension. The previous non-BaaS ROE trial was not adopted for large-scale production reporting, so Stage 10M-C-C replaces the main return calculation directly instead of showing a separate historical comparison.

The old standalone BaaS result card is removed from `/reports/asset-profitability`. The page keeps the original core result layout and adds BaaS only where it belongs operationally:

- `成本与资本结构拆解`: BaaS cost appears as a cost component.
- `单车收益试算列表`: BaaS contract status appears after vehicle status; BaaS cost appears before operating cost alongside the other detailed cost types.

## Cost Source

BaaS costs come from:

```text
VehicleBaasCostRecord
```

The reporting logic aggregates records by vehicle and ignores deleted records.

Included statuses:

```text
SCHEDULED
CONFIRMED
PAID
OVERDUE
```

Excluded statuses:

```text
WAIVED
VOIDED
```

## Accrual Method

BaaS costs use accrual accounting based on the service period:

```text
periodStart / periodEnd
```

`dueDate` is used for payment planning, payable reminders, overdue analysis, and cash-flow views only. `paidAt` is used to show actual payment state only. Neither field decides whether the cost belongs to the asset profitability period.

## Proration

If a BaaS cost record crosses the analysis window, the included amount is prorated by overlapping days:

```text
includedProratedAmount =
  costAmount * overlapDays / totalServiceDays
```

The implementation uses UTC date-only inclusive days:

```text
totalDays = daysBetween(periodStart, periodEnd) + 1
overlapDays = daysBetween(max(periodStart, analysisStart), min(periodEnd, analysisEnd)) + 1
```

Amounts are rounded to cents with integer math. Invalid records with `totalDays <= 0` are ignored for the report instead of failing the whole report.

## Main Formula

After BaaS inclusion:

```text
operatingCostAmount =
  existingOperatingCostAmount + baasProratedCostAmount

platformNetIncomeAmount =
  platformRetainedRevenueAmount - operatingCostAmount

roeTrial =
  platformNetIncomeAmount / roeEquityBaseAmount

annualizedRoeTrial =
  roeTrial * 365 / analysisDays

trialRoa =
  trialNetOperatingIncomeAmount / purchasePriceAmount
```

Residual sensitivity is also based on the BaaS-included `platformNetIncomeAmount`, without deducting BaaS a second time.

## API Shape

The asset profitability summary, vehicle list, and vehicle detail still return BaaS cost fields:

```text
baasCostAmount
baasCostFullRecordAmount
baasCostRecordCount
baasScheduledCostAmount
baasConfirmedCostAmount
baasPaidCostAmount
baasOverdueCostAmount
baasCostAllocationMethod = PERIOD_PRORATED
```

Vehicle detail cost records include:

```text
includedProratedAmount
fullCostRecordAmount
overlapDays
totalDays
allocationRatio
```

Backward-compatible `baasAdjusted*` fields may still be returned by the API, but they now mirror the main BaaS-included metrics and are not shown as a separate page or CSV result.

## CSV

CSV exports now place BaaS fields in the same semantic positions as the page:

- BaaS contract status follows vehicle status.
- BaaS cost fields appear before operating cost.
- Single-vehicle detail export includes cost period proration details.

CSV exports remain read-only and do not write audit records, accounting entries, bills, payment records, write-offs, or supplier payment orders.

## Historical Reports

Historical queries are dynamically recomputed with the new main formula. Existing exported CSV files, archived snapshots, and audit records are not overwritten. If historical BaaS costs are missing, operators should backfill `VehicleBaasCostRecord` before rerunning historical analysis.

## Out Of Scope

This stage does not:

- Generate bills or supplier payment orders.
- Generate `PaymentRecord` or `PaymentWriteOff`.
- Change finance write-off logic.
- Integrate with a BaaS provider API.
- Change order, contract, payment, entitlement, service-case, SMS, notification, or WeChat Pay main flows.
- Add a Prisma migration.
