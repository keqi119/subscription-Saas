# Vehicle-Model Clean Initialization Design

Date: 2026-07-30

Status: Approved design baseline

Related:

- GitHub PR [#223 refactor(vehicle): retire VehicleModel enum behind modelCode governance](https://github.com/keqi119/subscription-Saas/pull/223)
- [Three-Stage Subscription Platform Capability Roadmap](./2026-07-30-three-stage-subscription-capability-roadmap-design.md)

## Context

The system has not entered material production and later development will use a
fresh database. Current business test data is isolated and does not enter the
new database, so the implementation does not need compatibility, backfill, or
dual-write logic for the fixed `VehicleModel` enum or its test rows.

PR #223 performs the main enum-retirement changes:

- converts the eight enum columns to strings;
- removes the Prisma `VehicleModel` enum and PostgreSQL `vehicle_model` type;
- makes `VehicleModelDefinition.modelCode` the model master-data code;
- removes runtime dependency on the Prisma enum;
- adds no-enum governance and tests.

However, #223 deliberately preserves `vehicleModel`, `legacyVehicleModel`, and
historical compatibility snapshots, with physical compatibility-field removal
still marked `hardRemovalReady=false`. Merging it alone removes the enum type
restriction but does not produce the final clean schema.

## Decision

Add mandatory **Initialization Stage 0** before Stage 1A:

1. Stage 0A revalidates and integrates #223 against the latest main branch.
2. Stage 0B uses a separate additive migration and application change to remove
   old model compatibility fields and API contracts.
3. Initialize the fresh database on the final Stage 0 schema.
4. New business uses only `modelDefinitionId`, `modelCode`, and canonical model
   snapshots.
5. Do not preserve old enum or old-field compatibility for current test data.

Stage 0A and 0B are separate reviewable PRs. The already broad 72-file #223 is
not expanded further.

## Target Domain Model

### VehicleModelDefinition

`VehicleModelDefinition` is the only model master-data source and provides at
least:

- `id`;
- a unique `modelCode` that is immutable after creation;
- brand, series, model name, display name, model year, and required technical
  attributes;
- enabled state, effective time, and audit information.

Remove:

- `legacyVehicleModel`;
- enum-to-master-data alias mapping;
- fixed-enum query, validation, and Admin controls.

### Vehicle And Product References

- `Vehicle.modelDefinitionId` is required for new vehicle creation.
- `VehiclePackage` and `ProductPriceRule` reference model master data through
  `modelDefinitionId` only.
- Remove their `vehicleModel` compatibility fields.
- Keep `ProductPriceRule` itself for existing pricing compatibility; Stage 0
  does not delete that business capability.
- A future multi-model vehicle-package collection uses a normalized relation in
  Stage 1 product work. Stage 0 does not mix that feature into enum cleanup.

### Quote And Order Snapshots

New quotes and orders store:

- `modelDefinitionIdSnapshot`;
- `modelCodeSnapshot`;
- `modelDisplayNameSnapshot`.

Remove:

- `vehicleModel`;
- `legacyVehicleModelSnapshot`;
- `legacyVehicleModelCodeSnapshot`.

Snapshots preserve the contracted model fact and do not recalculate historical
contracts from current master data.

## API, UI, And Reporting Contracts

Write contracts:

- vehicles, products, quotes, orders, and filters use `modelDefinitionId`;
- do not accept `vehicleModel` or `legacyVehicleModel`;
- derive `modelCode` from selected master data rather than accepting free-text
  code as the relation key.

Read contracts:

- current entities return `modelDefinitionId`, `modelCode`, and
  `modelDisplayName`;
- quotes and orders return their corresponding snapshots;
- CSV, reporting, and Portal stop returning old enum or compatibility fields;
- remove old filters, Admin enum selectors, and compatibility parsing without a
  deprecation window.

The system is pre-production and the user has approved ending compatibility, so
this is a controlled breaking contract change.

## Migration Strategy

Never edit, delete, or squash committed or applied historical migrations.

The migration chain remains:

1. Historical migrations may create the `vehicle_model` enum and old columns
   while initializing a fresh database.
2. The #223 additive migration converts enum columns to strings and drops the
   database enum type.
3. A Stage 0B additive migration drops compatibility columns and creates or
   renames canonical snapshot columns.
4. Final schema, generated Prisma Client, and runtime contain no
   `VehicleModel`, `vehicleModel`, or `legacyVehicleModel` compatibility
   contract.

The new database has no business data, so Stage 0B does not backfill old test
rows. Controlled seeds create data directly through the final master-data
model.

## Initialization And Rollback

Sequence:

1. Back up and isolate the current test database as read-only.
2. Complete Stage 0A and 0B review and quality gates.
3. Create a separately named development database.
4. Apply the complete migration chain from zero.
5. Run final vehicle-model master-data seeds.
6. Verify product, vehicle, quote, order, Portal, and reporting flows.
7. Start Stage 1A only after Stage 0 acceptance.

On failure, do not change the old database or manually reverse-patch the new
one. Stop the application, fix unreleased code or add a corrective migration,
then recreate the non-production development database. Deleting any database
still requires approval for that exact target.

## Quality Gates

All must pass:

- no `enum VehicleModel` in the schema and no `vehicle_model` database type;
- no enum-typed or string-typed old `vehicleModel` or `legacyVehicleModel`
  Prisma fields;
- no Prisma `VehicleModel` import in runtime, DTOs, seeds, or executable
  scripts;
- write APIs do not accept old model inputs;
- responses, Portal, CSV, and reports do not output old model fields;
- quote and order creation always populate canonical snapshots;
- `modelCode` is unique and immutable after creation;
- vehicle, product, and pricing rules reference a valid `modelDefinitionId`;
- no-enum and no-compatibility-field guards pass;
- fresh migration, seed, API/Web type checks, relevant unit tests, and
  end-to-end main flows pass;
- `ProductPriceRule`, historical `RENT_TO_OWN` capability, and quote/order fields
  unrelated to model enum compatibility are not accidentally removed.

## Non-Goals

- No multi-model vehicle-package collection in Stage 0.
- No subscription pricing, contract, billing, or vehicle-state redesign.
- No current test-business-data migration.
- No historical migration modification.
- No unrelated code refactor.
- No reduction in fresh-install and incremental-upgrade migration validation.

## Acceptance Outcome

Stage 0 leaves one vehicle-model path:

`VehicleModelDefinition.id -> modelCode / displayName -> business references
and contract snapshots`

The fixed enum, old fields, alias resolution, and compatibility APIs do not
enter the new database or runtime. Stage 1 product, vehicle, contract, and
reporting work builds on stable model master data.
