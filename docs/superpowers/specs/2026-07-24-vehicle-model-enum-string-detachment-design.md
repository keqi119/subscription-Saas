# VehicleModel Enum String Detachment Design

## Status

Approved direction: retire the legacy `VehicleModel` enum in independent
phases. This document defines the first implementation phase after the
insurance source-of-truth work.

## Goal

Remove the Prisma/PostgreSQL `VehicleModel` enum without losing or rewriting
the existing model-code values stored in operational and historical rows.

The phase converts every enum-typed column in place to `VARCHAR(64)`. Existing
database column names and JSON compatibility fields remain stable, so an
existing value such as `ET5` is still returned as the same JSON string.

## Why This Phase Comes First

The repository already has:

- canonical `VehicleModelDefinition.modelCode`;
- `modelDefinitionId` relations for Vehicle, VehiclePackage, and
  ProductPriceRule;
- a `productVersionId + modelDefinitionId` ProductPriceRule unique constraint;
- immutable Quote/Order model display and string-code snapshots;
- new-write enforcement that is model-definition first.

However, hard deletion of all legacy columns is not yet safe because target
database coverage and external consumer sign-off have not been recorded.
Changing enum columns to strings is lossless and removes schema enum coupling
without claiming that the compatibility columns are ready for deletion.

## Schema Changes

Convert these eight columns from `VehicleModel` to `String`:

1. `VehiclePackage.vehicleModel`
2. `ProductPriceRule.vehicleModel`
3. `Vehicle.vehicleModel`
4. `VehicleModelDefinition.legacyVehicleModel`
5. `SubscriptionQuote.vehicleModel`
6. `SubscriptionQuote.legacyVehicleModelSnapshot`
7. `SubscriptionOrder.vehicleModel`
8. `SubscriptionOrder.legacyVehicleModelSnapshot`

Then remove `enum VehicleModel` from Prisma and drop PostgreSQL type
`vehicle_model`.

The migration must:

- wrap all column conversions and the enum drop in one explicit PostgreSQL
  transaction;
- use explicit `ALTER COLUMN ... TYPE VARCHAR(64) USING ...::text`;
- preserve nullability, indexes, unique constraints, and existing values;
- convert all dependent columns before dropping the enum type;
- fail naturally if an unlisted enum dependency still exists;
- avoid any amount, status, finance, billing, lease, contract, or delivery
  changes.

## Runtime Model-Code Rules

`VehicleModelDefinition.modelCode` becomes the only source for new model-code
compatibility values.

- `modelCode` is immutable after definition creation; display and descriptive
  metadata remain editable.
- New Vehicle, VehiclePackage, and ProductPriceRule writes continue to require
  `modelDefinitionId`.
- Their compatibility `vehicleModel` column is derived from
  `modelDefinition.modelCode`, not `legacyVehicleModel`.
- Model definitions no longer need a frozen enum mapping to participate in new
  business flows.
- Existing string compatibility values remain readable.
- Legacy-only business writes remain rejected.
- Quote/Order model-code fields become strings and continue to copy immutable
  snapshot values.

`legacyVehicleModel` remains a temporary string compatibility field on
VehicleModelDefinition during this phase. New UI/API writes no longer maintain
it. Its physical column is removed in the next phase after coverage checks.

## API And UI Compatibility

External JSON values do not change shape merely because the Prisma type changes
from enum to string.

Input fields that remain for compatibility use the same model-code format as
`modelCode`:

```text
^[A-Z0-9_-]+$
maximum length 64
```

Admin must stop presenting a fixed legacy enum selector:

- VehicleModelDefinition create/edit has no "legacy model" input.
- VehicleModelDefinition edit displays `modelCode` as read-only and omits it
  from update payloads.
- Vehicle and Product forms do not show or submit a separate legacy selector.
- Canonical model-definition selection remains required.
- Existing compatibility values may remain in API responses during this phase,
  but are not editable business inputs.

Reports and CSV output retain their current values and column order in this
phase. Removing legacy report fields is a separate external-contract change.

## Governance

Replace the enum freeze guard with a no-enum guard:

- fail if `enum VehicleModel` exists in Prisma schema;
- fail if any Prisma field has type `VehicleModel`;
- fail if runtime source imports `VehicleModel` from Prisma Client;
- pass when model codes are represented as strings and canonical writes use
  `modelDefinitionId`.

The external consumer registry continues to govern eventual compatibility-field
removal. Enum removal readiness and legacy-field retirement readiness are
separate decisions after this phase.

## Error Handling

- Reject malformed compatibility model-code strings with HTTP 400.
- Reject missing, deleted, or disabled model definitions exactly as today.
- Reject model-code/model-definition mismatches where the deprecated input is
  still accepted.
- Do not silently invent a model definition from an unknown string.
- Migration deployment must stop if PostgreSQL still finds an enum dependency.

## Testing

Required automated coverage:

- schema test proves no Prisma `VehicleModel` enum or enum-typed field remains;
- migration test proves all eight columns are cast before the enum is dropped;
- no-enum guard tests cover valid and invalid schemas;
- resolver tests use arbitrary master-data model codes, including a code that
  was never part of the old enum;
- Vehicle/Product tests prove `modelDefinitionId` writes derive `modelCode`;
- Quote/Order snapshot tests prove string historical values remain stable;
- DTO tests reject malformed strings and legacy-only writes;
- Admin tests prove legacy selectors are absent;
- report/CSV regression tests prove output shape and values remain stable;
- full API/Web typecheck, lint, test, and build pass.

## Non-Goals

This phase does not:

- delete operational or historical compatibility columns;
- backfill or mutate staging/production data;
- remove legacy API/CSV columns;
- change pricing formulas or quote/order amounts;
- change residual, finance, eSign, delivery, lease, or billing behavior;
- deploy or run migrations against staging/production;
- modify `VehicleModelDefinition.modelCode`.

## Follow-Up Phase

After this branch is merged and deployed, run read-only coverage checks for:

- operational `modelDefinitionId` completeness and consistency;
- Quote/Order string snapshot completeness;
- external API/CSV consumer sign-off;
- zero runtime fallback to compatibility columns.

Only then remove `vehicleModel`, `legacyVehicleModel`, and enum-era snapshot
columns in a separate guarded migration.
