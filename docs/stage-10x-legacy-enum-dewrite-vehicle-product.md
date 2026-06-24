# Stage 10X-O Vehicle / Product Legacy Enum Dewrite

## 1. Goal

Stage 10X-O moves Vehicle and Product configuration writes out of direct legacy `VehicleModel` enum input.

New business writes now use `modelDefinitionId` as the primary model input. The legacy `vehicleModel` enum fields remain in the schema and API responses for compatibility, matching, historical fallback, and unique-key constraints, but they are derived by the backend from `VehicleModelDefinition.legacyVehicleModel`.

## 2. Dewrite Definition

Legacy enum dewrite means:

1. Users and new API clients should choose a `VehicleModelDefinition`.
2. Create/update services validate the selected model definition.
3. The backend writes `modelDefinitionId`.
4. The backend derives the required legacy `vehicleModel` value from the selected definition.
5. Legacy-only `vehicleModel` create/update payloads are rejected for the Vehicle / VehiclePackage / ProductPriceRule surfaces covered by this stage.

This is not enum removal. `VehicleModel` remains frozen and compatibility-only.

## 3. Vehicle Create / Update

Vehicle create now requires `modelDefinitionId`.

If a create request only sends `vehicleModel`, the API returns 400 and asks the caller to send `modelDefinitionId`.

When `modelDefinitionId` is supplied:

1. `VehicleModelDefinition` must exist.
2. It must not be deleted.
3. It must be enabled.
4. It must have `legacyVehicleModel`.
5. If `vehicleModel` is also supplied, it must match `legacyVehicleModel`.

Vehicle update does not force historical vehicles to be migrated when editing non-model fields. If the caller intends to change the model, it must send `modelDefinitionId`; legacy-only `vehicleModel` updates are rejected. Clearing `modelDefinitionId` remains rejected.

## 4. Product Configuration Create / Update

VehiclePackage create now requires `modelDefinitionId`.

ProductPriceRule create now requires `modelDefinitionId`.

For both surfaces, the backend derives `vehicleModel` from the selected `VehicleModelDefinition`. Legacy-only create requests return 400.

Updates follow the same rule:

1. `modelDefinitionId` updates are allowed and sync the legacy enum field.
2. Legacy-only `vehicleModel` updates are rejected.
3. Editing non-model fields on historical records is still allowed.
4. Clearing `modelDefinitionId` remains rejected.

## 5. Frontend Changes

The vehicle page and product package page keep the legacy enum visible only as a read-only compatibility field.

New records require the model-code master-data selector. Form submission sends `modelDefinitionId` and lets the backend derive `vehicleModel`.

Historical records without `modelDefinitionId` can still be viewed and edited for non-model fields. To fix the model association, users choose a model-code master-data row.

## 6. Compatibility

Existing legacy fallback stays in place:

1. `Vehicle.vehicleModel` remains available in responses.
2. `VehiclePackage.vehicleModel` and `ProductPriceRule.vehicleModel` remain available for existing matching and unique constraints.
3. Portal, Reports, Residual, Quote / Order snapshots, ROE, depreciation, BaaS, payment, write-off, billing, contract, and service-case flows are not changed in this stage.

## 7. Not Changed

Stage 10X-O does not:

1. Delete `VehicleModel`.
2. Change Prisma schema.
3. Add a migration.
4. Migrate historical vehicles or product rules.
5. Change Quote / Order snapshots.
6. Change Portal / Reports / Residual logic.
7. Change finance or payment flows.

## 8. Follow-Up

Stage 10X-P has formalized legacy enum read-only mode across the system:

1. Review any remaining service write paths.
2. Keep API responses backward-compatible.
3. Hide legacy enum editing in all UI surfaces.
4. Keep legacy enum fields for fallback, CSV, historical explanation, and compatibility until a later removal feasibility review.

The next review stage is Stage 10X-Q, which should re-check whether the enum is now only frozen schema / snapshot / fallback compatibility and whether removal is still worth the migration risk.
