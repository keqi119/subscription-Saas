# Stage 10X Vehicle Model No-enum Guard

## Current Status

The Prisma `VehicleModel` enum has been replaced by string model-code columns. The release invariant is now:

```text
No VehicleModel enum block in Prisma schema.
No Prisma schema field typed as VehicleModel.
No runtime import or namespace dependency on Prisma VehicleModel.
New writes resolve vehicleModel from VehicleModelDefinition.modelCode.
```

`node scripts/check-vehicle-model-no-enum.mjs` enforces this invariant for schema and runtime sources.

## Compatibility Commands

The existing commands remain supported for release and CI compatibility:

```powershell
pnpm vehicle-model:enum-freeze
pnpm vehicle-model:enum-freeze:test
```

`vehicle-model:enum-freeze` is now a compatibility wrapper around the no-enum guard. It no longer compares a frozen enum value list, because canonical model codes are string values maintained through `VehicleModelDefinition`.

Run the direct guard in new automation:

```powershell
node scripts/check-vehicle-model-no-enum.mjs
node --test scripts/check-vehicle-model-no-enum.test.mjs
```

## Model-code Rule

New models are created through `VehicleModelDefinition` with a canonical `modelCode`. `legacyVehicleModel` is a historical alias only; it is not a Prisma enum and is not an Admin editing control.

Seeds and guarded backfills may read both `modelCode` and the historical alias so that existing facts retain their original string values. Backfills remain dry-run by default and keep their explicit apply and production-approval protections.

## Separate Compatibility-field Retirement

Passing the no-enum guard does **not** sign off retirement of external `vehicleModel`, `legacyVehicleModel`, or CSV compatibility fields.

Those consumers remain tracked in [vehicle-model-external-contract-consumer-register.json](vehicle-model-external-contract-consumer-register.json), including Portal Catalog. Their status is separately `NOT_READY` until owners migrate or explicitly approve an exception. No compatibility column, historical snapshot, API field, CSV field, or Portal filter is removed by this guard.
