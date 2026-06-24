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
```

All fields are nullable. Existing quote and order rows are not backfilled or rewritten by this stage.

## 3. Quote Create Behavior

New quote creation writes model snapshots only at create time:

```text
modelDefinitionIdSnapshot = selected vehicle / package / rule modelDefinitionId when available
modelDisplayNameSnapshot = modelDefinition.displayName when available
legacyVehicleModelSnapshot = legacy vehicleModel
```

If no model definition is available, `modelDisplayNameSnapshot` falls back to the legacy `VehicleModel` value.

## 4. Order Create Behavior

New order creation freezes the quote model snapshot:

```text
order.modelDefinitionIdSnapshot = quote.modelDefinitionIdSnapshot
order.modelDisplayNameSnapshot = quote.modelDisplayNameSnapshot
order.legacyVehicleModelSnapshot = quote.legacyVehicleModelSnapshot
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

Stage 10X-M-D may optionally backfill additive quote / order snapshot fields after a separate dry-run and manual approval. That stage should not rewrite the existing legacy snapshot fields.
