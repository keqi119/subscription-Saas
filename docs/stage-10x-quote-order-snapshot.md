# Stage 10X-M-C Quote / Order Model Snapshot

## 1. Goal

Stage 10X-M-C adds an immutable model explanation layer to new `SubscriptionQuote` and `SubscriptionOrder` records.

The goal is to preserve what model information was selected at quote / order creation time while keeping the existing legacy `vehicleModel` field for compatibility.

## 2. Added Snapshot Fields

`SubscriptionQuote` and `SubscriptionOrder` now include nullable additive fields:

```text
modelDefinitionIdSnapshot
modelDisplayNameSnapshot
legacyVehicleModelSnapshot
legacyVehicleModelCodeSnapshot
```

All fields are nullable. Existing quote and order rows are not backfilled or rewritten by this stage.

## 3. Quote Create Behavior

New quote creation writes model snapshots only at create time:

```text
modelDefinitionIdSnapshot = selected vehicle / package / rule modelDefinitionId when available
modelDisplayNameSnapshot = modelDefinition.displayName when available
legacyVehicleModelSnapshot = legacy vehicleModel
legacyVehicleModelCodeSnapshot = legacy vehicleModel as string code
```

If no model definition is available, `modelDisplayNameSnapshot` falls back to the legacy `VehicleModel` value.

## 4. Order Create Behavior

New order creation freezes the quote model snapshot:

```text
order.modelDefinitionIdSnapshot = quote.modelDefinitionIdSnapshot
order.modelDisplayNameSnapshot = quote.modelDisplayNameSnapshot
order.legacyVehicleModelSnapshot = quote.legacyVehicleModelSnapshot
order.legacyVehicleModelCodeSnapshot = quote.legacyVehicleModelCodeSnapshot
```

If an older quote has no snapshot values, order creation falls back to the same vehicle-based snapshot resolution used by quote creation.

## 5. Immutability

Snapshot fields are create-time audit fields. Update, confirm, cancel, contract, payment, billing, write-off, and order-change flows do not overwrite them.

## 6. Display Priority

Quote and order responses expose the new snapshot fields while keeping `vehicleModel`.

Display should prefer:

```text
modelDisplayNameSnapshot
modelDefinition displayName lookup
legacyVehicleModelCodeSnapshot
legacyVehicleModelSnapshot / vehicleModel
```

## 7. No Business Calculation Changes

This stage does not change:

```text
ROE
depreciation
BaaS
pricing formulas
payment
write-off
billing
contract status
Product / Residual / Vehicle matching logic
```

## 8. Historical Data

Historical quote / order data remains unchanged. The new fields are nullable so old records remain readable and auditable through the existing legacy `vehicleModel` snapshot.

## 9. Follow-up

Stage 10X-M-D backfills additive quote / order snapshot fields with a guarded dry-run / apply script. It does not rewrite the original `vehicleModel` or any quote / order financial facts.

Stage 10X-M-E updates Quote / Order read paths, customer portal order display, and order detail CSV export to prefer immutable snapshot display fields for historical explanation.

Stage 10X-N adds `legacyVehicleModelCodeSnapshot` so Quote / Order history has a string model-code explanation field independent of the frozen `VehicleModel` enum.
