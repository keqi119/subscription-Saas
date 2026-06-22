# Stage 10M-C-A BaaS Battery Contracts And Cost Ledger

Stage 10M-C-A adds the operational foundation for vehicle BaaS battery service contracts and monthly cost records.

This stage is intentionally limited to contract and ledger management. It does not change asset profitability formulas, ROA / ROE trial calculations, payment write-off logic, customer billing, supplier payment orders, or vehicle/order state machines.

## Goals

- Maintain vehicle-scoped BaaS battery service contracts.
- Store provider, provider contract number, battery package, battery serial number, effective dates, billing cycle, rental amount, payment day, grace days, tax and invoice flags.
- Upload private BaaS contract attachments.
- Generate monthly / quarterly / yearly cost records from active or suspended BaaS contracts.
- Track cost period, due date, amount, source, and payment status.
- Provide a back-office BaaS contract page.
- Show a compact BaaS summary in vehicle detail.

## Existing Battery Context

`Vehicle` already has:

```text
batteryCapacityKwh
batteryUsageType
```

`VehicleBatteryUsageType` already contains:

```text
BUYOUT
BAAS
```

Before this stage, `BAAS` was only a vehicle attribute used in vehicle display, residual-market dimensions, and reporting dimensions. There was no BaaS contract, rental amount, monthly payment day, attachment, or cost ledger model.

## Models

New models:

- `VehicleBaasContract`
- `VehicleBaasContractAttachment`
- `VehicleBaasCostRecord`

New enums:

- `VehicleBaasContractStatus`
- `VehicleBaasBillingCycle`
- `VehicleBaasContractAttachmentType`
- `VehicleBaasCostRecordStatus`
- `VehicleBaasCostSource`

## Contract Rules

- Contracts are created as `DRAFT` by default.
- Activation requires the vehicle `batteryUsageType` to be `BAAS`.
- One vehicle cannot have two active BaaS contracts at the same time.
- `paymentDayOfMonth` accepts `1-31`.
- Contract status operations write status timestamps for activation, suspension, termination, and archive.
- Archive is soft operational archive, not physical deletion.

## Attachments

Attachments are stored privately through `StorageService`:

```text
vehicle-baas-contracts/{contractId}/{yyyy}/{uuid}-{filename}
```

Preview uses API stream routes. Back office does not receive public OSS URLs in API DTOs.

## Cost Record Generation

Generation request:

```json
{
  "fromPeriod": "2026-07",
  "toPeriod": "2026-12",
  "dryRun": true
}
```

Rules:

- Only `ACTIVE` or `SUSPENDED` contracts can generate records.
- `MONTHLY` generates one record per month.
- `QUARTERLY` generates one record every three months.
- `YEARLY` generates one record every twelve months.
- `dueDate` is the configured payment day in the cost period month.
- If the configured day exceeds the month length, due date uses month end.
- `contractId + costPeriod` is idempotent; existing periods are skipped.
- `dryRun=true` does not write records.
- Generated records start as `SCHEDULED`.

## Cost Status Flow

Supported actions:

```text
confirm: SCHEDULED -> CONFIRMED
mark-paid: SCHEDULED / CONFIRMED -> PAID
void: SCHEDULED / CONFIRMED -> VOIDED
```

This stage does not create supplier payment orders, receivable bills, invoices, payment orders, or write-off records.

## Back Office

New page:

```text
/vehicle-baas-contracts
```

Capabilities:

- List and filter contracts.
- Create and edit contracts.
- Activate, suspend, terminate, and archive contracts.
- Upload and preview contract attachments.
- Generate BaaS cost records.
- Confirm, mark paid, and void cost records.

Vehicle detail now shows:

- Current BaaS contract.
- Provider.
- Rental amount.
- Payment day.
- Next due date.
- Unpaid cost count.
- Contract status.
- Link to BaaS contract management.

## Permissions

New permissions:

```text
vehicle_baas:view
vehicle_baas:manage
```

Role defaults:

- `ADMIN`: all permissions.
- `OP`: view/manage.
- `FI`: view/manage.
- `SA`: view.
- `GM`: view.

After `pnpm prisma:seed`, users should log in again so refreshed tokens include the new permission/menu set.

## Reporting Boundary

This stage does not integrate BaaS costs into:

- Asset profitability.
- ROA / ROE trial formulas.
- CSV exports.
- Reporting aggregates.
- Finance write-off or accounting ledgers.

Stage 10M-C-B should define the reporting aggregation and CSV/export口径 before BaaS costs affect asset profitability analysis.

## Out Of Scope

Stage 10M-C-A does not include:

- BaaS provider API integration.
- Supplier payment orders.
- Invoice management.
- Automatic asset profitability formula changes.
- Customer bills.
- Payment or write-off logic.
- Vehicle status changes.
- Order, contract, entitlement, service-case, SMS, notification, or WeChat Pay main-flow changes.
- Production deployment.
- `prisma migrate reset`.
- `prisma db push`.

## Next Stage

Recommended next stage:

```text
Stage 10M-C-B: BaaS cost integration into asset profitability analysis
```
