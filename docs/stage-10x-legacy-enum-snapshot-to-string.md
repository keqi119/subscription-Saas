# Stage 10X-N Legacy Enum Snapshot to String Snapshot

## 1. Goal

Stage 10X-N adds a string model-code snapshot to Quote / Order history.

The goal is to let historical Quote / Order explanations survive a future `VehicleModel` enum retirement without changing existing financial or order facts.

## 2. Why String Snapshot

`legacyVehicleModelSnapshot` is still typed as `VehicleModel?`. That keeps current compatibility stable, but it also means historical snapshots remain coupled to the frozen enum.

The new string field preserves the model code text independently:

```text
legacyVehicleModelCodeSnapshot String?
```

This is additive. It does not replace or delete:

```text
vehicleModel
legacyVehicleModelSnapshot
modelDefinitionIdSnapshot
modelDisplayNameSnapshot
```

## 3. Quote / Order Fields

`SubscriptionQuote` and `SubscriptionOrder` now include:

```text
legacyVehicleModelCodeSnapshot
```

The field is nullable and has no backfill migration. Historical data is handled by the guarded script.

## 4. New Data Write Logic

New Quote creation writes:

```text
modelDefinitionIdSnapshot = selected runtime modelDefinitionId when available
modelDisplayNameSnapshot = modelDefinition.displayName when available, otherwise legacy code
legacyVehicleModelSnapshot = legacy vehicleModel enum
legacyVehicleModelCodeSnapshot = legacy vehicleModel as string
```

New Order creation freezes the Quote snapshot:

```text
order.modelDefinitionIdSnapshot = quote.modelDefinitionIdSnapshot
order.modelDisplayNameSnapshot = quote.modelDisplayNameSnapshot
order.legacyVehicleModelSnapshot = quote.legacyVehicleModelSnapshot
order.legacyVehicleModelCodeSnapshot = quote.legacyVehicleModelCodeSnapshot
```

If an old Quote has no code snapshot, Order creation derives it from:

```text
quote.legacyVehicleModelSnapshot
quote.vehicleModel
current vehicle.vehicleModel fallback
```

## 5. Display Helper Priority

`buildQuoteOrderModelDisplay` now reads:

```text
1. modelDisplayNameSnapshot
2. modelDefinitionIdSnapshot with optional runtime display lookup
3. legacyVehicleModelCodeSnapshot
4. legacyVehicleModelSnapshot
5. runtime modelDefinition display
6. runtime vehicleModel
7. null
```

It also returns:

```text
legacyVehicleModelCode
```

and adds `SNAPSHOT_MODEL_CODE` as a display source.

## 6. Backfill Script

The string snapshot backfill is separate from the Stage 10X-M-D enum snapshot backfill:

```text
pnpm quote-order:model-code-snapshot-backfill:dry-run
QUOTE_ORDER_MODEL_CODE_SNAPSHOT_BACKFILL_APPLY=1 pnpm quote-order:model-code-snapshot-backfill:apply
pnpm quote-order:model-code-snapshot-backfill:test
```

Apply mode also refuses production unless:

```text
ALLOW_PRODUCTION_QUOTE_ORDER_MODEL_CODE_SNAPSHOT_BACKFILL=1
```

The script only updates:

```text
SubscriptionQuote.legacyVehicleModelCodeSnapshot
SubscriptionOrder.legacyVehicleModelCodeSnapshot
```

It does not update Vehicle, Product, Residual, Contract, Billing, Payment, WriteOff, Deposit, or ServiceCase data.

## 7. Local / Dev Backfill Result

Local/dev apply was executed after a clean dry-run:

```text
Initial dry-run:
Quote total=10 matched=10 unresolved=0 conflicts=0
Order total=8 matched=8 unresolved=0 conflicts=0

Apply:
Quote updated=10
Order updated=8

Idempotency dry-run:
Quote matched=0 skippedExisting=10 unresolved=0 conflicts=0
Order matched=0 skippedExisting=8 unresolved=0 conflicts=0
```

Production was not executed.

## 8. Audit Note

```text
legacyVehicleModelCodeSnapshot is an additive historical explanation field.
It does not replace the original enum vehicleModel or legacyVehicleModelSnapshot.
Backfilled values are reconstructed from existing enum snapshots and do not alter original quote/order facts.
```

## 9. Out of Scope

This stage does not:

```text
delete VehicleModel enum
modify Vehicle.vehicleModel
modify Quote.vehicleModel or Order.vehicleModel
delete legacyVehicleModelSnapshot
recalculate Quote / Order
change Quote / Order amounts
change order status machine
change contracts
change bills
change payment / write-off
change Product matching
change Portal catalog
change Residual
change ROE / depreciation / BaaS
deploy to production
```

## 10. Follow-up

Stage 10X-O reduces new Vehicle / Product writes that accept legacy enum input directly. New Vehicle, VehiclePackage, and ProductPriceRule create/update model changes use `modelDefinitionId`; legacy `vehicleModel` remains derived for compatibility.

Stage 10X-P formalizes read-only legacy enum mode. VehicleModel remains frozen, legacy-only writes are rejected across Vehicle, Product, and Residual new-data entrances, and legacy fields remain available for responses, reports, CSV, snapshots, fallback labels, and audit compatibility.
