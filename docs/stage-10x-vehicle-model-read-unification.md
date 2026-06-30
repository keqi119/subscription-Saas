# Stage 10X-R Vehicle Model Read-Path Unification

## Goal

Stage 10X-R adds a read-path unification layer for the vehicle model master-data migration.
The system keeps the legacy `VehicleModel` enum for compatibility, but runtime reads now resolve model identity through `modelDefinitionId` first.

No schema change, migration, data rewrite, enum removal, or production deploy is part of this stage.

## Core Layer

`apps/api/src/common/vehicle-model-resolver.ts` introduces two read helpers:

- `resolveVehicleModel(source)`: returns a normalized model identity and display payload.
- `vehicleModelReadPathMatches(left, right)`: compares model identities by `modelDefinitionId` when both sides have it; if one side is still legacy-only, it falls back to legacy enum as a migration-safety compatibility path.

`VehicleModelLegacyAdapter` remains the compatibility boundary for deprecated legacy input. It resolves legacy `vehicleModel` to `VehicleModelDefinition` so legacy filters can be converted to `modelDefinitionId` before querying business data.

## Product And Price Rules

`ProductPriceRule` read queries now use `modelDefinitionId`.

- List ordering uses `modelDefinitionId`.
- Direct price-rule quote creation resolves legacy input through `VehicleModelLegacyAdapter` before querying `ProductPriceRule`.
- Active price-rule lookup queries `ProductPriceRule.modelDefinitionId`.
- Legacy `vehicleModel` remains returned for compatibility and display fallback only.

Subscription-plan availability checks now use `modelDefinitionId` for package matching where current objects have master-data links, with legacy fallback only for historical records that have not been fully linked yet.

## Quote And Order Display

Quote and Order historical display continues to use snapshot mode.

Display priority is:

1. `modelDisplayNameSnapshot`
2. `modelDefinitionIdSnapshot` with lookup display if supplied
3. `legacyVehicleModelCodeSnapshot`
4. `legacyVehicleModelSnapshot`
5. runtime `modelDefinition.displayName`
6. runtime legacy `vehicleModel`

This keeps historical explanation immutable while allowing old records without full snapshots to remain readable.

## Reports And CSV

Report filters that accept legacy `vehicleModel` now resolve it through `VehicleModelDefinition.legacyVehicleModel` and query by `modelDefinitionId`.

- Vehicle runtime reports filter by `Vehicle.modelDefinitionId`.
- Quote / Order historical reports filter by `modelDefinitionIdSnapshot`, then fallback to runtime vehicle `modelDefinitionId` only when the snapshot id is missing.
- Legacy enum values remain available in response and CSV columns as compatibility display fields, not as the primary business filter.

## Compatibility Boundary

Allowed legacy enum usage after this stage:

- response compatibility fields
- CSV compatibility columns
- historical snapshot rendering
- read-only fallback display
- freeze guard
- migration and backfill scripts

Forbidden business read pattern:

- querying current business records by `vehicleModel` when `modelDefinitionId` is available or resolvable.

## No-op Confirmation

This stage does not:

- modify Prisma schema
- add migrations
- remove `VehicleModel`
- rewrite existing rows
- change Quote / Order amounts or statuses
- change payment, write-off, billing, ROE, depreciation, BaaS, or residual forecast calculations

## Follow-up

Future stages may further reduce legacy read contracts, including ProductPriceRule uniqueness migration, legacy report filter deprecation, and a final enum-removal dry-run. The expected near-term posture remains frozen read-only legacy compatibility.
