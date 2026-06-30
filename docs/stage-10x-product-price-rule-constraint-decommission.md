# Stage 10X-W ProductPriceRule Legacy Constraint Decommission

## 1. Goal

Stage 10X-W removes `ProductPriceRule` schema uniqueness from the frozen legacy `VehicleModel` enum path.

Removed from Prisma schema:

```prisma
@@unique([productVersionId, vehicleModel])
```

Retained as the canonical pricing guard:

```prisma
@@unique([productVersionId, modelDefinitionId], map: "product_price_rule_product_version_model_definition_key")
```

This stage does not remove `VehicleModel`, does not delete the `vehicleModel` column, does not rewrite price rules, and does not change pricing formulas.

## 2. Migration File

Migration:

```text
apps/api/prisma/migrations/20260630173000_product_price_rule_legacy_vehicle_model_unique_decommission/migration.sql
```

Migration SQL:

```sql
DROP INDEX "product_price_rule_product_version_id_vehicle_model_key";
```

The migration drops only the legacy unique index. It keeps:

- `ProductPriceRule.vehicleModel`;
- `product_price_rule_vehicle_model_idx`;
- `product_price_rule_product_version_model_definition_key`.

## 3. Safety Model

The safe state after Stage 10X-W is:

```text
ProductPriceRule pricing uniqueness = productVersionId + modelDefinitionId
legacy vehicleModel = compatibility display / fallback column only
```

Data loss risk is avoided because no table rows are updated or deleted.

Pricing corruption risk is avoided because ProductService already resolves price rules by `modelDefinitionId`, and Stage 10X-V added the canonical unique index before this legacy index was removed.

## 4. Validation Before Removal

Run:

```powershell
pnpm product-price-rule:constraint-readiness
pnpm product-price-rule:constraint-decommission
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api test -- product-components.spec.ts subscription-plan.spec.ts
pnpm release:check
```

The decommission check validates:

- Prisma schema no longer declares `@@unique([productVersionId, vehicleModel])`;
- Prisma schema still declares the `modelDefinitionId` unique guard;
- database no longer has `product_price_rule_product_version_id_vehicle_model_key`;
- database still has `product_price_rule_product_version_model_definition_key`;
- ProductPriceRule data readiness is clean;
- current rows have no duplicate `(productVersionId, vehicleModel)` scopes, so rollback can recreate the legacy index if needed.

Current local decommission result:

```json
{
  "ready": true,
  "database": {
    "legacyDatabaseUniquePresent": false,
    "modelDefinitionDatabaseUniquePresent": true
  },
  "schema": {
    "legacySchemaUniquePresent": false,
    "modelDefinitionSchemaUniquePresent": true
  },
  "readinessSummary": {
    "duplicateModelDefinitionScopes": 0,
    "legacyMappingMismatches": 0,
    "missingModelDefinitionId": 0,
    "totalRules": 2
  },
  "legacyRollbackSummary": {
    "duplicateLegacyScopes": 0
  }
}
```

## 5. Backward Compatibility

Backward compatibility is preserved by keeping:

- `ProductPriceRule.vehicleModel`;
- API response `vehicleModel` fields;
- CSV/report compatibility fields;
- legacy display fallback;
- system-derived writes from `modelDefinitionId` to `vehicleModel`.

What changed is only the database uniqueness authority. New duplicate pricing scopes are guarded by `modelDefinitionId`, not by enum value.

## 6. Pricing Integrity

Pricing integrity must remain unchanged:

- direct price-rule lookup uses `modelDefinitionId`;
- package quote matching remains unchanged;
- `monthlyFeeRate` is not recalculated;
- Quote / Order snapshots are not rewritten;
- ROE, depreciation, BaaS, billing, payment, and write-off logic are untouched.

Regression checks:

```powershell
pnpm --filter @subscription-saas/api test -- product-components.spec.ts subscription-plan.spec.ts
pnpm --filter @subscription-saas/api test
```

## 7. Rollback Plan

Application rollback:

1. rollback to the previous application artifact;
2. keep `ProductPriceRule.vehicleModel` available for legacy display and compatibility;
3. do not rewrite price rules.

Schema rollback:

```sql
CREATE UNIQUE INDEX "product_price_rule_product_version_id_vehicle_model_key"
ON "product_price_rule"("product_version_id", "vehicle_model");
```

Before recreating the legacy unique index, verify no duplicate legacy scopes exist:

```sql
SELECT product_version_id, vehicle_model, COUNT(*)
FROM product_price_rule
WHERE deleted_at IS NULL
GROUP BY product_version_id, vehicle_model
HAVING COUNT(*) > 1;
```

The release gate runs `pnpm product-price-rule:constraint-decommission`, which keeps this rollback-safety condition visible during the transition.

## 8. Production Execution Plan

Recommended production sequence:

1. verify Stage 10X-V migration is deployed;
2. run `pnpm product-price-rule:constraint-readiness`;
3. confirm `missingModelDefinitionId = 0`, `duplicateModelDefinitionScopes = 0`, `legacyMappingMismatches = 0`;
4. take a database backup;
5. deploy this migration in a low-traffic window;
6. run `pnpm product-price-rule:constraint-decommission`;
7. run quote/pricing smoke tests;
8. keep the rollback SQL and previous application artifact available.

This task did not execute production deploy.

## 9. What This Stage Does Not Do

Stage 10X-W does not:

- delete `VehicleModel`;
- remove enum values;
- remove `ProductPriceRule.vehicleModel`;
- remove API/CSV/report compatibility fields;
- mutate price rule data;
- mutate Quote / Order history;
- change pricing, ROE, depreciation, BaaS, billing, payment, write-off, portal, reports, residual, or contract logic;
- execute production deployment.

## 10. Follow-Up

After Stage 10X-W, ProductPriceRule uniqueness no longer blocks eventual enum removal.

Remaining enum-removal work should focus on:

| Stage | Goal |
| --- | --- |
| 10X-X | API / CSV v2 contract cutover and legacy response removal |
| 10X-Y | final enum removal dry-run on a production-like clone |
| 10X-Z | production enum removal only after all hard gates are green |

The recommended posture remains conservative: keep frozen read-only `VehicleModel` until external contracts and historical compatibility are fully retired.
