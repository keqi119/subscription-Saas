# Stage 10X-P Legacy Enum Read-Only Mode

## 1. Goal

Stage 10X-P formally moves `VehicleModel` into frozen read-only legacy compatibility mode.

The enum is still present in Prisma schema, API responses, labels, historical snapshots, reports, CSV exports, tests, seed data, and the enum freeze guard. It is no longer a user-facing primary input for new model-specific business writes.

## 2. Read-Only Mode Definition

Read-only mode means new business flows use `modelDefinitionId` as the primary model input.

Where legacy enum fields are still required by schema or compatibility contracts, the backend derives them from `VehicleModelDefinition.legacyVehicleModel`.

This is not enum removal. `VehicleModel` remains frozen and must not receive new values.

## 3. Allowed Uses

The following uses remain valid:

1. Legacy schema fields remain nullable or required according to the existing schema.
2. API responses may continue returning `vehicleModel`.
3. CSV and report outputs may include legacy `vehicleModel` columns.
4. Report filters may continue accepting `vehicleModel` as a compatibility filter.
5. Quote / Order snapshots may keep `legacyVehicleModelSnapshot` and `legacyVehicleModelCodeSnapshot`.
6. System-derived writes may set `vehicleModel` from `modelDefinitionId`.
7. Seed and test fixtures may write legacy enum fields only when they also write the corresponding `modelDefinitionId` or when intentionally modeling historical legacy data.
8. The enum freeze guard reads the enum to prevent expansion.

## 4. Forbidden Uses

The following uses are forbidden for new business writes:

1. Creating or updating a Vehicle with legacy-only `vehicleModel`.
2. Creating or updating a VehiclePackage with legacy-only `vehicleModel`.
3. Creating or updating a ProductPriceRule with legacy-only `vehicleModel`.
4. Creating residual market samples with legacy-only brand / series / model instead of `modelDefinitionId`.
5. Generating new residual curves with legacy-only brand / series / model instead of `modelDefinitionId`.
6. Creating target-specific ResidualModelRun records with legacy-only target fields instead of `targetModelDefinitionId`.
7. Showing editable legacy enum dropdowns as the primary input in frontend forms.
8. Recommending `vehicleModel` as a primary API input in documentation.
9. Adding new values to the frozen `VehicleModel` enum.

## 5. System-Derived Writes

The backend still writes legacy enum values where existing schema fields require them.

The only accepted direction is:

```text
modelDefinitionId -> VehicleModelDefinition.legacyVehicleModel -> legacy vehicleModel field
```

The reverse direction is no longer accepted for new write paths.

## 6. DTO Deprecation

Create / update DTOs keep `vehicleModel` for API compatibility, but they are marked deprecated or legacy-only.

Report DTOs keep `vehicleModel` as a compatibility filter and prefer `modelDefinitionId` for new integrations.

## 7. Frontend Strategy

The Vehicle and Product pages use model-code master-data selectors as the editable controls.

Legacy enum fields remain visible only as disabled compatibility fields that are automatically filled from the selected model definition.

The residual market page requires model-code master data for new samples, new curves, and target-specific model runs. Legacy brand / series / model fields remain as compatibility display columns and derived metadata.

## 8. Reports And CSV Compatibility

Reports and CSV exports keep legacy fields for audit users and historical compatibility.

This stage does not remove `vehicleModel` report filters. New UI and API integrations should prefer `modelDefinitionId`, but existing legacy filters remain valid read-only compatibility surfaces.

## 9. Freeze Guard

The Stage 10X-K enum freeze guard remains active.

`pnpm vehicle-model:enum-freeze` and `pnpm release:check` continue to fail if the Prisma `VehicleModel` enum is expanded, reduced, or renamed.

## 10. No-op Scope

Stage 10X-P does not:

```text
delete VehicleModel enum
modify Prisma schema
add migrations
migrate historical data
remove vehicleModel from responses
remove report vehicleModel filters
modify Quote / Order snapshots
modify Product matching
modify Portal catalog visibility
modify Residual forecast lookup
modify ROE / depreciation / BaaS
modify payment / write-off / billing / contract / service-case logic
deploy to production
```

## 11. Follow-up

Stage 10X-Q should re-run the enum removal feasibility review after read-only mode is stable.

Expected outcome remains conservative: keep the enum frozen as legacy compatibility unless all schema, snapshot, matching, reporting, and audit dependencies have a lower-risk replacement.
