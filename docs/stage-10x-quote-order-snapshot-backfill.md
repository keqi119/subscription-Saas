# Stage 10X-M-D Quote / Order Snapshot Backfill

## 1. Goal

Stage 10X-M-D backfills the additive model snapshot fields introduced in Stage 10X-M-C for historical `SubscriptionQuote` and `SubscriptionOrder` rows.

The backfill is explanation-only. It does not rewrite the original `vehicleModel`, quote amounts, order amounts, contract state, bill state, payment state, write-off state, ROE, depreciation, or BaaS logic.

## 2. Backfill Scope

Only these nullable snapshot fields are in scope:

```text
SubscriptionQuote.modelDefinitionIdSnapshot
SubscriptionQuote.modelDisplayNameSnapshot
SubscriptionQuote.legacyVehicleModelSnapshot
SubscriptionOrder.modelDefinitionIdSnapshot
SubscriptionOrder.modelDisplayNameSnapshot
SubscriptionOrder.legacyVehicleModelSnapshot
```

Rows are processed only when all three snapshot fields on the row are `null`.

## 3. Out of Scope

The script does not update:

```text
Vehicle
VehiclePackage
ProductPriceRule
VehicleMarketPriceObservation
VehicleResidualCurve
VehicleResidualForecast
ResidualModelRun
PaymentRecord
PaymentWriteOff
ReceivableBill
Contract
```

No Prisma schema changes or migrations are included in this stage.

## 4. Quote Mapping

`SubscriptionQuote` rows are mapped by:

```text
SubscriptionQuote.vehicleModel -> VehicleModelDefinition.legacyVehicleModel
```

Mapping rules:

```text
VehicleModelDefinition.deletedAt = null
VehicleModelDefinition.legacyVehicleModel is not null
enabled=false definitions are allowed for historical explanation
mapping must be unique
```

Unresolved or conflicting rows block apply.

## 5. Order Mapping

`SubscriptionOrder` rows use this priority:

```text
1. Copy the linked Quote snapshot when it already exists.
2. Copy the linked Quote snapshot planned in the same dry-run.
3. Fallback to SubscriptionOrder.vehicleModel -> VehicleModelDefinition.legacyVehicleModel.
```

Orders with no usable quote snapshot and no unique legacy mapping are unresolved and block apply.

## 6. Scripts

Added scripts:

```text
scripts/quote-order-model-snapshot-backfill.mjs
scripts/quote-order-model-snapshot-backfill-core.mjs
scripts/quote-order-model-snapshot-backfill-core.test.mjs
```

Commands:

```powershell
pnpm quote-order:snapshot-backfill:dry-run
$env:QUOTE_ORDER_SNAPSHOT_BACKFILL_APPLY="1"; pnpm quote-order:snapshot-backfill:apply
pnpm quote-order:snapshot-backfill:test
```

Reports are written to:

```text
.tmp/quote-order-snapshot-backfill/latest.json
.tmp/quote-order-snapshot-backfill/latest.md
```

`.tmp/` is ignored by Git.

## 7. Safety Gates

Default mode is dry-run.

Apply requires both:

```text
--apply
QUOTE_ORDER_SNAPSHOT_BACKFILL_APPLY=1
```

Production apply is rejected unless this is also set:

```text
ALLOW_PRODUCTION_QUOTE_ORDER_SNAPSHOT_BACKFILL=1
```

Production execution requires a database backup and manual approval. This stage did not execute production apply.

## 8. Dry-run Result

Command:

```powershell
pnpm quote-order:snapshot-backfill:dry-run
```

Environment:

```text
NODE_ENV=development
APP_ENV unset
isProduction=false
```

Initial dry-run result:

| Table | total | matched | skippedExisting | unresolved | conflicts |
| --- | ---: | ---: | ---: | ---: | ---: |
| SubscriptionQuote | 10 | 10 | 0 | 0 | 0 |
| SubscriptionOrder | 8 | 8 | 0 | 0 | 0 |
| Total | 18 | 18 | 0 | 0 | 0 |

The dry-run was clean, with no unresolved or conflicting records.

## 9. Apply Result

Apply was executed against the local/dev database only:

```powershell
$env:QUOTE_ORDER_SNAPSHOT_BACKFILL_APPLY="1"; pnpm quote-order:snapshot-backfill:apply
```

Environment:

```text
NODE_ENV=development
APP_ENV unset
isProduction=false
Production not executed
```

Apply result:

| Table | matched | updated | skippedExisting | unresolved | conflicts |
| --- | ---: | ---: | ---: | ---: | ---: |
| SubscriptionQuote | 10 | 10 | 0 | 0 | 0 |
| SubscriptionOrder | 8 | 8 | 0 | 0 | 0 |
| Total | 18 | 18 | 0 | 0 | 0 |

## 10. Idempotency

After apply, dry-run was executed again:

```powershell
pnpm quote-order:snapshot-backfill:dry-run
```

Idempotency result:

| Table | total | matched | skippedExisting | unresolved | conflicts |
| --- | ---: | ---: | ---: | ---: | ---: |
| SubscriptionQuote | 10 | 0 | 10 | 0 | 0 |
| SubscriptionOrder | 8 | 0 | 8 | 0 | 0 |
| Total | 18 | 0 | 18 | 0 | 0 |

The script is repeatable. A second run has no rows to update and does not overwrite existing snapshot fields.

## 11. Audit Note

Backfilled snapshots are reconstructed from legacy vehicleModel and current VehicleModelDefinition mapping.
They are additive explanation fields and do not modify original quote/order facts.

## 12. Production Runbook

Before production apply:

```text
1. Back up the database.
2. Run pnpm quote-order:snapshot-backfill:dry-run.
3. Confirm unresolved=0 and conflicts=0.
4. Review .tmp/quote-order-snapshot-backfill/latest.json.
5. Obtain manual approval.
6. Set QUOTE_ORDER_SNAPSHOT_BACKFILL_APPLY=1.
7. Set ALLOW_PRODUCTION_QUOTE_ORDER_SNAPSHOT_BACKFILL=1 when APP_ENV or NODE_ENV is production.
8. Run pnpm quote-order:snapshot-backfill:apply.
9. Run pnpm quote-order:snapshot-backfill:dry-run again to verify idempotency.
```

## 13. Follow-up

Stage 10X-M-E updates Quote / Order API display, customer portal order display, admin pages, and order detail CSV reads to prefer immutable snapshot display fields for historical explanation while keeping runtime modelDefinition reads for current operational objects.
