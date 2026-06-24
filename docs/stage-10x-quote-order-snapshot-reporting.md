# Stage 10X-M-E Quote / Order Snapshot Reporting

## 1. Goal

Stage 10X-M-E switches Quote / Order historical display and exports to snapshot mode.

Quote and Order rows now explain the vehicle model that was frozen at quote / order time, while current operational objects continue to use runtime `modelDefinitionId`.

## 2. Snapshot Mode vs Runtime Mode

Snapshot mode is used for:

```text
SubscriptionQuote display
SubscriptionOrder display
admin quote / order detail pages
customer portal order display
order detail CSV export
historical audit explanation
```

Runtime mode remains used for:

```text
Vehicle management
Product / package matching
Portal catalog current vehicle display
Reports based on current vehicle analysis
Residual market / forecast runtime lookup
ROE / depreciation / BaaS calculations
```

## 3. Display Priority

Quote / Order model display uses this priority:

```text
1. modelDisplayNameSnapshot
2. modelDefinitionIdSnapshot with runtime lookup when available
3. legacyVehicleModelCodeSnapshot
4. legacyVehicleModelSnapshot label
5. runtime vehicle modelDefinition displayName
6. legacy vehicleModel label
7. unknown
```

The helper returns both:

```text
modelDisplayName
modelDisplaySource
```

`modelDisplaySource` can be:

```text
SNAPSHOT
SNAPSHOT_MODEL_CODE
SNAPSHOT_LEGACY_ENUM
RUNTIME_MODEL_DEFINITION
LEGACY_VEHICLE_MODEL
UNKNOWN
```

## 4. API Responses

Admin Quote and Order responses continue to include the legacy `vehicleModel` field and now also expose:

```text
modelDefinitionIdSnapshot
modelDisplayNameSnapshot
legacyVehicleModelSnapshot
legacyVehicleModelCodeSnapshot
modelDisplayName
modelDisplaySource
```

No old response fields are removed.

## 5. Portal Display

Customer portal order responses keep internal snapshot identifiers hidden.

The portal vehicle summary uses snapshot-derived `displayName` when available, then falls back to the existing runtime vehicle summary.

## 6. CSV

Order detail CSV now uses snapshot display for the model display column and adds a snapshot source column.

The legacy vehicle model column remains present for compatibility.

## 7. No Data Changes

This stage does not:

```text
write snapshot fields
rerun snapshot backfill
overwrite existing snapshots
rewrite legacy vehicleModel
recalculate quotes or orders
```

## 8. No Financial Flow Changes

This stage does not modify:

```text
quote amount calculation
order amount calculation
order status machine
contracts
bills
payments
write-offs
ROE
depreciation
BaaS
```

## 9. Follow-up

Stage 10X-M-F should perform the final VehicleModel enum retirement feasibility review with the runtime / snapshot read split in place.

Stage 10X-N adds `legacyVehicleModelCodeSnapshot` and keeps Portal customer-facing responses limited to friendly display names rather than internal snapshot fields.
