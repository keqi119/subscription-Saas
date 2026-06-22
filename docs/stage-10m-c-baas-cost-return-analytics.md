# Stage 10M-C-B BaaS Cost Return Analytics

Stage 10M-C-B integrates BaaS battery cost records into asset profitability analysis as a supplemental reporting dimension.

This stage does not change the main asset profitability formulas. `platformNetIncomeAmount`, `roeTrial`, `annualizedRoeTrial`, `trialRoa`, finance write-off, billing, payment, supplier payment, and accounting flows remain unchanged.

## Goals

- Aggregate BaaS costs from `VehicleBaasCostRecord`.
- Show BaaS cost impact in asset-return summary, vehicle list, vehicle detail, and CSV exports.
- Add BaaS adjusted platform net income, ROE, and annualized ROE.
- Keep BaaS adjusted metrics clearly separate from the main ROE / ROA metrics.

## Cost Source

BaaS costs come from:

```text
VehicleBaasCostRecord
```

Aggregation is vehicle-scoped and read-only.

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

The report period uses `dueDate` within the same asset profitability date range.

## Added Summary Fields

```text
baasCostVehicleCount
baasCostRecordCount
baasCostAmount
baasScheduledCostAmount
baasConfirmedCostAmount
baasPaidCostAmount
baasOverdueCostAmount
baasAdjustedPlatformNetIncomeAmount
baasAdjustedRoeTrial
baasAdjustedAnnualizedRoeTrial
```

## Added Vehicle List Fields

```text
baasContractStatus
baasContractNo
baasProviderName
baasCostRecordCount
baasCostAmount
baasScheduledCostAmount
baasConfirmedCostAmount
baasPaidCostAmount
baasOverdueCostAmount
baasAdjustedPlatformNetIncomeAmount
baasAdjustedRoeTrial
baasAdjustedAnnualizedRoeTrial
```

## Added Vehicle Detail Fields

```text
baasCostSummary
baasCurrentContract
baasCostRecords
baasAdjustedReturn
```

`baasCurrentContract` is the current active BaaS contract summary when available.

`baasCostRecords` includes report-period cost records only and does not expose storage, payment write-off, supplier-payment, or accounting internals.

## Adjusted Metric Formula

```text
baasAdjustedPlatformNetIncomeAmount =
  platformNetIncomeAmount - baasCostAmount

baasAdjustedRoeTrial =
  baasAdjustedPlatformNetIncomeAmount / roeEquityBaseAmount

baasAdjustedAnnualizedRoeTrial =
  baasAdjustedRoeTrial * 365 / analysisDays
```

If `platformNetIncomeAmount` or `roeEquityBaseAmount` is unavailable, adjusted ROE returns `null`.

## CSV Updates

Updated exports:

```text
GET /api/reports/asset-profitability/returns/summary/export
GET /api/reports/asset-profitability/returns/vehicles/export
GET /api/reports/asset-profitability/returns/vehicles/:id/export
```

CSV now includes:

- BaaS cost vehicle count and record count.
- BaaS cost total and status breakdown.
- BaaS current contract summary.
- BaaS adjusted platform net income / ROE / annualized ROE.
- BaaS cost record list in vehicle detail export.

## Frontend

`/reports/asset-profitability` now shows:

- BaaS cost summary cards in the return-trial tab.
- BaaS contract status, BaaS cost, and BaaS adjusted ROE columns in the vehicle return list.
- BaaS contract, cost summary, cost records, and adjusted return section in the vehicle detail drawer.

The page explicitly states that BaaS costs are supplemental and do not replace the main ROE / platform net income.

## Out Of Scope

This stage does not:

- Modify main `platformNetIncomeAmount`.
- Modify main `roeTrial`.
- Modify main `annualizedRoeTrial`.
- Modify `trialRoa`.
- Generate bills, payment records, write-offs, supplier payment orders, or accounting entries.
- Integrate with a BaaS provider API.
- Change order, contract, vehicle, payment, entitlement, service-case, SMS, notification, or WeChat Pay main flows.
- Add a Prisma migration.

## Next Decision Point

Before Stage 10M-C-C, confirm whether BaaS costs should become part of the main asset profitability formula or remain a supplemental adjusted metric.
