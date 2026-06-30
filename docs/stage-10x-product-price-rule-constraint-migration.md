# Stage 10X-V ProductPriceRule Constraint Migration

## 1. Goal

Stage 10X-V migrates `ProductPriceRule` uniqueness toward `modelDefinitionId`.

This stage adds an additive database uniqueness guard:

```prisma
@@unique([productVersionId, modelDefinitionId], map: "product_price_rule_product_version_model_definition_key")
```

The legacy constraint remains:

```prisma
@@unique([productVersionId, vehicleModel])
```

Therefore this stage does not remove `VehicleModel`, does not delete legacy columns, and does not change pricing formulas.

## 2. Migration File

Migration:

```text
apps/api/prisma/migrations/20260630170000_product_price_rule_model_definition_unique/migration.sql
```

Migration SQL:

```sql
CREATE UNIQUE INDEX "product_price_rule_product_version_model_definition_key"
ON "product_price_rule"("product_version_id", "model_definition_id");
```

This is additive and data-preserving.

## 3. Current Code Path

Before this migration, application logic had already moved ProductPriceRule reads to `modelDefinitionId`:

```text
ProductService.findActivePriceRule(productVersionId, modelDefinitionId)
```

New ProductPriceRule writes already require `modelDefinitionId` and derive legacy `vehicleModel` from `VehicleModelDefinition.legacyVehicleModel`.

This stage aligns the database uniqueness guard with the runtime truth source while keeping the old guard in place.

## 4. Dual-Write / Coexist Strategy

During the coexist phase:

| Field / constraint | Status | Purpose |
| --- | --- | --- |
| `ProductPriceRule.modelDefinitionId` | required by service for new writes | canonical price-rule scope |
| `ProductPriceRule.vehicleModel` | still written by backend from model definition | legacy compatibility |
| `@@unique([productVersionId, vehicleModel])` | retained | protects legacy clients and rollback |
| `@@unique([productVersionId, modelDefinitionId])` | newly added | protects canonical pricing scope |

Rules:

- new writes continue setting both `modelDefinitionId` and derived `vehicleModel`;
- old constraint remains until enum removal is much later;
- no quote pricing path may query by `vehicleModel`;
- duplicate canonical price rules are rejected at DB level.

## 5. Safe Data Backfill Strategy

No data rows are modified in this stage.

Before applying the constraint, run:

```powershell
pnpm product-price-rule:constraint-readiness
```

The readiness script checks:

- every active ProductPriceRule has `modelDefinitionId`;
- no duplicate `(productVersionId, modelDefinitionId)` scope exists;
- `vehicleModel` matches `modelDefinition.legacyVehicleModel` when both are present.

Current local result:

```json
{
  "ready": true,
  "summary": {
    "duplicateModelDefinitionScopes": 0,
    "legacyMappingMismatches": 0,
    "missingModelDefinitionId": 0,
    "totalRules": 2
  }
}
```

If any blocker appears, do not apply the migration. Resolve it through a separate reviewed data correction/backfill stage.

## 6. Pricing Integrity Validation

Required validation:

```powershell
pnpm product-price-rule:constraint-readiness
pnpm --filter @subscription-saas/api test -- product-components.spec.ts subscription-plan.spec.ts
pnpm release:check
```

Pricing integrity criteria:

- direct price-rule quote path uses `modelDefinitionId`;
- package quote path remains unchanged;
- no duplicate canonical price-rule scope exists;
- quote snapshots still freeze the selected model display and legacy code;
- `monthlyFeeRate`, mileage, over-mileage fee, energy limit, deposit, ROE, depreciation, BaaS, billing, payment, and write-off logic are unchanged.

## 7. Rollback Strategy

Rollback is non-destructive because this stage only adds an index.

Application rollback:

1. rollback application code first if a release issue appears;
2. old `productVersionId + vehicleModel` constraint remains available;
3. direct quote pricing can be restored to the previous application version without data loss.

Schema rollback:

```sql
DROP INDEX IF EXISTS "product_price_rule_product_version_model_definition_key";
```

Rollback safety:

- do not drop the legacy unique constraint in this stage;
- do not modify ProductPriceRule amounts;
- do not rewrite Quote / Order history;
- do not delete model definitions.

## 8. Migration Execution Plan

### Preflight

Run:

```powershell
pnpm product-price-rule:constraint-readiness
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Required:

```text
constraint readiness ready = true
Prisma schema valid
generated client succeeds
database migrations up to date before applying new migration
```

### Local / Staging Apply

Run:

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate deploy --schema prisma/schema.prisma
pnpm product-price-rule:constraint-readiness
pnpm release:check
```

### Production Cutover

Recommended:

```text
low-traffic deployment window
database backup completed
readiness script green immediately before deploy
application rollback artifact available
finance/product owner available for quote smoke test
```

For larger production datasets, consider replacing the migration SQL with an online index strategy validated on a production-like clone before deploy. If online index semantics cannot be guaranteed by the migration runner, use a short maintenance window instead of claiming zero downtime.

### Post-Deploy Validation

Run:

```powershell
pnpm product-price-rule:constraint-readiness
pnpm --filter @subscription-saas/api test -- product-components.spec.ts subscription-plan.spec.ts
pnpm release:check
```

Business smoke:

- create direct price-rule quote by `modelDefinitionId`;
- verify duplicate price-rule create/update is rejected;
- verify existing subscription-plan quote still works;
- verify report and CSV row counts are unchanged.

## 9. Validation Gates

The stage is complete only if:

- new Prisma schema validates;
- migration deploy succeeds locally/staging;
- ProductPriceRule readiness report is ready;
- product component tests pass;
- subscription quote tests pass;
- release check passes;
- no production deploy was executed from this task.

## 10. What This Stage Does Not Do

This stage does not:

- remove `VehicleModel`;
- drop `ProductPriceRule.vehicleModel`;
- drop `@@unique([productVersionId, vehicleModel])`;
- modify price amounts or pricing formulas;
- rewrite Quote / Order history;
- modify reports, portal, residual, payment, billing, ROE, depreciation, or BaaS logic;
- execute production deployment.

## 11. Follow-Up

After this stage:

| Stage | Goal |
| --- | --- |
| 10X-W | Decommission legacy ProductPriceRule `productVersionId + vehicleModel` unique constraint |
| 10X-X | API / CSV v2 contract cutover and legacy response removal |
| 10X-Y | final enum removal dry-run on production-like clone |

Do not remove the `VehicleModel` enum until all external contract and schema-removal gates are green.
