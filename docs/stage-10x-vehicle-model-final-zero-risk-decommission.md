# Stage 10X Vehicle Model Final Decommission Status

## Completed Type Conversion

The application schema and runtime no longer use Prisma `VehicleModel`:

```text
enum block removed from schema source
enum-typed model fields converted to String / VARCHAR(64)
runtime Prisma VehicleModel imports removed
new writes use VehicleModelDefinition.modelCode
```

The executable enforcement is:

```powershell
node scripts/check-vehicle-model-no-enum.mjs
pnpm vehicle-model:enum-freeze
```

The second command is retained only as a compatibility wrapper. It delegates to the no-enum guard and does not maintain a frozen list of model values.

This source-level completion is not a statement that the migration has been deployed to any database. Deployment still requires the approved migration procedure, a production-like rehearsal, backup, and supported migration execution.

## External Compatibility Retirement

External compatibility-field retirement is a separate gate and is currently `NOT_READY`.

Tracked surfaces include API DTOs, reports, CSV exports, Admin report UIs, residual-market exports, vehicle responses, model-definition mapping metadata, and Portal Catalog. The authoritative register is [vehicle-model-external-contract-consumer-register.json](vehicle-model-external-contract-consumer-register.json).

```powershell
pnpm vehicle-model:removal-readiness
pnpm vehicle-model:contract-governance
```

The readiness report now gives two independent results:

```text
enumTypeRemoval.decision = READY
compatibilityFieldRetirement.decision = NOT_READY
```

`enumTypeRemoval` is enforced by the no-enum guard. `compatibilityFieldRetirement` remains blocked until registered consumers are migrated or approved through governance. It must not retroactively block the lossless enum-to-string type conversion.

## Explicit Non-sign-off

This stage does not claim that any of the following has been removed or signed off:

```text
Vehicle.vehicleModel or other string compatibility columns
Quote / Order historical snapshots
legacyVehicleModel aliases
API response or request compatibility fields
CSV report columns
Portal Catalog vehicleModel filtering
external consumers
```

The next retirement work must retain string-only compatibility where required, preserve historical facts, update the consumer register, and complete the relevant owner approvals before any field or contract removal.
