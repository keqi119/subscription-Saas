# Stage 10X Vehicle Model Schema and Compatibility Retirement Preparation

## Current State

The codebase has completed the lossless Prisma type conversion:

```text
VehicleModel enum source is removed.
Former enum-backed columns are string model-code columns.
Runtime and Admin controls use VehicleModelDefinition and modelDefinitionId.
Historical values remain readable as strings.
```

The no-enum guard is the acceptance criterion for this completed type-removal stage:

```powershell
node scripts/check-vehicle-model-no-enum.mjs
```

No database was accessed or migrated as part of this documentation update. The enum-to-string migration remains subject to normal deployment review and rehearsal.

## Compatibility Fields Are Separate

The following are still compatibility concerns, not remaining Prisma enum dependencies:

```text
Vehicle.vehicleModel and related operational string code fields
VehicleModelDefinition.legacyVehicleModel historical alias
VehiclePackage and ProductPriceRule string compatibility values
SubscriptionQuote and SubscriptionOrder original-code snapshots
API, CSV, report, and Portal Catalog vehicleModel surfaces
```

They remain registered and `NOT_READY` for external retirement until consumer ownership and migration are complete. Their presence must not be reported as a failure of the no-enum guard or as a reason to restore an enum dependency.

## Required Governance

```powershell
pnpm vehicle-model:removal-readiness
pnpm vehicle-model:contract-governance
```

Interpret the outputs separately:

`vehicle-model:removal-readiness` executes the same no-enum dependency check before reporting `enumTypeRemoval`.

| Gate | Current meaning |
| --- | --- |
| `enumTypeRemoval.decision` | Type conversion is protected by the no-enum guard. |
| `compatibilityFieldRetirement.decision` | External field and CSV retirement is not approved while registered consumers remain. |
| `hardRemovalReady` | Contract-governance status for removing compatibility fields, not a prerequisite for the completed type conversion. |

Portal Catalog is a registered compatibility consumer whenever the scanner detects its `vehicleModel` path.

## Future Removal Rules

Before removing any string compatibility column, snapshot, API field, CSV column, or Portal filter:

1. Preserve original historical code meaning with a string snapshot or documented replacement.
2. Migrate or obtain an approved exception for every registered external consumer.
3. Rehearse the migration on a production-like clone and retain rollback evidence.
4. Run the no-enum guard, readiness command, contract governance command, API/Web typechecks, and relevant regression suites.

Do not claim that legacy columns are removed or that consumer sign-off is complete until these gates are satisfied.
