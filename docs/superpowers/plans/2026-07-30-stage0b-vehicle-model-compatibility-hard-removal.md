# 阶段0B：车型兼容字段最终移除实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在阶段0A通过后，删除旧`vehicleModel`/`legacyVehicleModel`数据库字段和API契约，使全新数据库只使用`VehicleModelDefinition`引用及规范化Quote/Order车型快照。

**Architecture:** 通过一个独立增量迁移形成最终Schema；应用写入统一使用`modelDefinitionId`，读取统一返回`modelCode`和`modelDisplayName`，合同事实使用不可变快照。删除兼容适配器而不是继续增加别名分支，车型包多车型集合留在阶段1产品设计。

**Tech Stack:** NestJS、Prisma、PostgreSQL、Next.js、TypeScript、class-validator、Vitest、Node test runner、pnpm、PowerShell。

## Global Constraints

- 本计划只能在阶段0A验收通过的提交上执行。
- 使用`superpowers:using-git-worktrees`创建独立`stage0b/vehicle-model-compatibility-hard-removal`工作树。
- 不修改、删除或压缩历史迁移；新增一个增量迁移。
- 不迁移当前测试业务数据，不编写旧测试行回填。
- 数据库演练使用明确命名的新库`subscription_saas_stage0b_verify`，不得连接当前测试库。
- 删除旧车型API和字段不提供弃用期；这是已批准的预生产破坏性变更。
- 保留`ProductPriceRule`模型、`RENT_TO_OWN`能力和与车型兼容无关的Quote/Order字段。
- 不实现车型包多车型集合，不修改定价、合同、账单、车辆状态、财务或支付业务规则。
- 不新增依赖，不修改锁文件。
- 所有行为先写失败测试，再做最小实现。
- 不推送或创建PR，直到用户明确要求发布。

---

### Task 1: 定义最终Schema和无兼容字段守卫

**Files:**
- Create: `apps/api/test/vehicle-model-canonical-schema.spec.ts`
- Create: `scripts/check-vehicle-model-no-compatibility.mjs`
- Create: `scripts/check-vehicle-model-no-compatibility.test.mjs`
- Modify: `scripts/release-check.mjs`

**Interfaces:**
- Produces: `assertNoVehicleModelCompatibility(schemaText, runtimeFiles)` and an executable release guard.
- Consumes: Prisma schema text and source files under API, Web, shared packages, seeds, and executable scripts.

- [ ] **Step 1: 写Schema失败测试**

Create assertions equivalent to:

```ts
const forbiddenSchemaPatterns = [
  /\bvehicleModel\s+(?:String|VehicleModel)/,
  /\blegacyVehicleModel\b/,
  /\blegacyVehicleModelSnapshot\b/,
  /\blegacyVehicleModelCodeSnapshot\b/,
  /\benum\s+VehicleModel\b/
];

for (const pattern of forbiddenSchemaPatterns) {
  expect(schemaText).not.toMatch(pattern);
}

expect(schemaText).toMatch(/modelDefinitionId\s+String\s+@map\("model_definition_id"\)/);
expect(schemaText).toMatch(/modelCodeSnapshot\s+String\s+@map\("model_code_snapshot"\)/);
expect(schemaText).toMatch(/modelDisplayNameSnapshot\s+String\s+@map\("model_display_name_snapshot"\)/);
```

Also assert `Vehicle`, `VehiclePackage`, and `ProductPriceRule` have required `modelDefinitionId`.

- [ ] **Step 2: 写守卫失败测试**

Cover rejection of:

```text
DTO property vehicleModel
response mapping legacyVehicleModel
Prisma select legacyVehicleModelSnapshot
CSV header legacyVehicleModelCodeSnapshot
runtime import VehicleModel
```

Allow documentation that names removed fields only when the guard excludes non-executable design/history documents.

- [ ] **Step 3: 运行测试确认RED**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model-canonical-schema.spec.ts
node --test scripts/check-vehicle-model-no-compatibility.test.mjs
```

Expected: FAIL because Stage0A still contains string compatibility fields and runtime adapters.

- [ ] **Step 4: 实现无兼容字段守卫**

Export:

```js
export function assertNoVehicleModelCompatibility({ schemaText, runtimeFiles }) {
  // Return { violations } where every item contains file and category.
}
```

The CLI scans:

```text
apps/api/prisma/schema.prisma
apps/api/src
apps/web/src
packages/shared/src
apps/api/prisma/seed*.mjs
scripts executable .mjs files
```

Exclude only the guard implementation/test and explicit archived documentation.

- [ ] **Step 5: 接入发布检查**

Add direct execution of:

```powershell
node --test scripts/check-vehicle-model-no-compatibility.test.mjs
node scripts/check-vehicle-model-no-compatibility.mjs
```

to `scripts/release-check.mjs` after the Stage0A no-enum guard.

- [ ] **Step 6: 提交测试和守卫**

```powershell
git add apps/api/test/vehicle-model-canonical-schema.spec.ts scripts/check-vehicle-model-no-compatibility.mjs scripts/check-vehicle-model-no-compatibility.test.mjs scripts/release-check.mjs
git commit -m "test(vehicle): define canonical model schema contract"
```

### Task 2: 创建最终Prisma Schema和增量迁移

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260730180000_vehicle_model_compatibility_hard_removal/migration.sql`
- Test: `apps/api/test/vehicle-model-canonical-schema.spec.ts`

**Interfaces:**
- Produces: required master-data references and canonical quote/order snapshot columns.
- Consumes: Stage0A string columns; no business-row backfill.

- [ ] **Step 1: 修改Prisma模型**

Apply this target:

```prisma
model Vehicle {
  modelDefinitionId String                 @map("model_definition_id") @db.Uuid
  modelDefinition   VehicleModelDefinition @relation(fields: [modelDefinitionId], references: [id])
}

model VehiclePackage {
  modelDefinitionId String                 @map("model_definition_id") @db.Uuid
  modelDefinition   VehicleModelDefinition @relation(fields: [modelDefinitionId], references: [id])
}

model ProductPriceRule {
  modelDefinitionId String                 @map("model_definition_id") @db.Uuid
  modelDefinition   VehicleModelDefinition @relation(fields: [modelDefinitionId], references: [id])
}
```

Remove `VehicleModelDefinition.legacyVehicleModel` and its index.

For both `SubscriptionQuote` and `SubscriptionOrder`, keep:

```prisma
modelDefinitionIdSnapshot String @map("model_definition_id_snapshot") @db.Uuid
modelCodeSnapshot         String @map("model_code_snapshot") @db.VarChar(64)
modelDisplayNameSnapshot  String @map("model_display_name_snapshot") @db.VarChar(128)
```

Remove all old model compatibility fields.

- [ ] **Step 2: 编写显式迁移SQL**

Use:

```sql
BEGIN;

ALTER TABLE "subscription_quote"
  RENAME COLUMN "legacy_vehicle_model_code_snapshot" TO "model_code_snapshot";
ALTER TABLE "subscription_order"
  RENAME COLUMN "legacy_vehicle_model_code_snapshot" TO "model_code_snapshot";

ALTER TABLE "vehicle_package" DROP COLUMN "vehicle_model";
ALTER TABLE "product_price_rule" DROP COLUMN "vehicle_model";
ALTER TABLE "vehicle" DROP COLUMN "vehicle_model";
ALTER TABLE "vehicle_model_definition" DROP COLUMN "legacy_vehicle_model";
ALTER TABLE "subscription_quote" DROP COLUMN "vehicle_model";
ALTER TABLE "subscription_quote" DROP COLUMN "legacy_vehicle_model_snapshot";
ALTER TABLE "subscription_order" DROP COLUMN "vehicle_model";
ALTER TABLE "subscription_order" DROP COLUMN "legacy_vehicle_model_snapshot";

ALTER TABLE "vehicle" ALTER COLUMN "model_definition_id" SET NOT NULL;
ALTER TABLE "vehicle_package" ALTER COLUMN "model_definition_id" SET NOT NULL;
ALTER TABLE "product_price_rule" ALTER COLUMN "model_definition_id" SET NOT NULL;
ALTER TABLE "subscription_quote" ALTER COLUMN "model_definition_id_snapshot" SET NOT NULL;
ALTER TABLE "subscription_quote" ALTER COLUMN "model_code_snapshot" SET NOT NULL;
ALTER TABLE "subscription_quote" ALTER COLUMN "model_display_name_snapshot" SET NOT NULL;
ALTER TABLE "subscription_order" ALTER COLUMN "model_definition_id_snapshot" SET NOT NULL;
ALTER TABLE "subscription_order" ALTER COLUMN "model_code_snapshot" SET NOT NULL;
ALTER TABLE "subscription_order" ALTER COLUMN "model_display_name_snapshot" SET NOT NULL;

COMMIT;
```

Do not add data updates to this migration.

- [ ] **Step 3: 运行Schema测试**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model-canonical-schema.spec.ts
```

Expected: schema assertions PASS; runtime guard may still fail until later tasks.

- [ ] **Step 4: 验证Prisma**

Run:

```powershell
pnpm prisma:validate
pnpm prisma:generate
```

Expected: validate passes; generated client exposes only canonical fields.

- [ ] **Step 5: 提交Schema和迁移**

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260730180000_vehicle_model_compatibility_hard_removal/migration.sql apps/api/test/vehicle-model-canonical-schema.spec.ts
git commit -m "refactor(vehicle): remove model compatibility columns"
```

### Task 3: 收敛车型解析与合同快照

**Files:**
- Modify: `apps/api/src/common/vehicle-model-resolver.ts`
- Modify: `apps/api/src/common/vehicle-model-snapshot.ts`
- Test: `apps/api/test/vehicle-model-resolver.spec.ts`
- Test: `apps/api/test/quote-order-model-snapshot.spec.ts`

**Interfaces:**
- Produces: `requireActiveVehicleModelDefinition()` and `buildVehicleModelSnapshot()`.
- Consumes: required `modelDefinitionId` only.

- [ ] **Step 1: 写失败测试**

Tests must assert:

```ts
await expect(
  requireActiveVehicleModelDefinition(prisma, "definition-id")
).resolves.toEqual({
  modelDefinitionId: "definition-id",
  modelCode: "MODEL_X_2027",
  modelDisplayName: "Model X 2027"
});

expect(buildVehicleModelSnapshot(definition)).toEqual({
  modelDefinitionIdSnapshot: "definition-id",
  modelCodeSnapshot: "MODEL_X_2027",
  modelDisplayNameSnapshot: "Model X 2027"
});
```

Also assert missing, deleted, and disabled definitions throw a Chinese `BadRequestException`.

- [ ] **Step 2: 运行测试确认RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model-resolver.spec.ts test/quote-order-model-snapshot.spec.ts
```

Expected: FAIL because Stage0A exports legacy adapter types and snapshots.

- [ ] **Step 3: 实现规范化解析接口**

The resolver exports:

```ts
export type VehicleModelIdentity = {
  modelDefinitionId: string;
  modelCode: string;
  modelDisplayName: string;
};

export async function requireActiveVehicleModelDefinition(
  prisma: VehicleModelDefinitionReader,
  modelDefinitionId: string
): Promise<VehicleModelIdentity>;
```

It queries only `{ id, modelCode, displayName, enabled, deletedAt }` by ID. Remove alias lookup, free-text code lookup, `VehicleModelLegacyAdapter`, compatibility code sets, and tracking of `LEGACY_ENUM`.

- [ ] **Step 4: 实现规范化快照**

Export:

```ts
export type VehicleModelSnapshot = {
  modelDefinitionIdSnapshot: string;
  modelCodeSnapshot: string;
  modelDisplayNameSnapshot: string;
};

export function buildVehicleModelSnapshot(
  identity: VehicleModelIdentity
): VehicleModelSnapshot {
  return {
    modelDefinitionIdSnapshot: identity.modelDefinitionId,
    modelCodeSnapshot: identity.modelCode,
    modelDisplayNameSnapshot: identity.modelDisplayName
  };
}
```

- [ ] **Step 5: 运行测试和API类型检查**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model-resolver.spec.ts test/quote-order-model-snapshot.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: focused tests pass; typecheck reports remaining call sites to fix in later tasks.

- [ ] **Step 6: 提交解析与快照**

```powershell
git add apps/api/src/common/vehicle-model-resolver.ts apps/api/src/common/vehicle-model-snapshot.ts apps/api/test/vehicle-model-resolver.spec.ts apps/api/test/quote-order-model-snapshot.spec.ts
git commit -m "refactor(vehicle): use canonical model identity and snapshots"
```

### Task 4: 删除写入DTO兼容字段并改造领域写路径

**Files:**
- Modify: `apps/api/src/vehicle/dto/vehicle.dto.ts`
- Modify: `apps/api/src/product/dto/product.dto.ts`
- Modify: `apps/api/src/vehicle-model-definition/dto/vehicle-model-definition.dto.ts`
- Modify: `apps/api/src/vehicle/vehicle.service.ts`
- Modify: `apps/api/src/product/product.service.ts`
- Modify: `apps/api/src/order/order.service.ts`
- Modify: `apps/api/src/vehicle-model-definition/vehicle-model-definition.service.ts`
- Test: `apps/api/test/vehicle-model.spec.ts`
- Test: `apps/api/test/product-components.spec.ts`
- Test: `apps/api/test/vehicle-model-definition.spec.ts`
- Test: `apps/api/test/quote-order-model-snapshot.spec.ts`
- Test: `apps/api/test/order-contract.spec.ts`

**Interfaces:**
- Consumes: `requireActiveVehicleModelDefinition()` and `buildVehicleModelSnapshot()` from Task 3.
- Produces: modelDefinitionId-only writes and mandatory canonical contract snapshots.

- [ ] **Step 1: 写DTO和写路径失败测试**

Assert:

```text
CreateVehicleDto rejects missing modelDefinitionId
CreateVehiclePackageDto rejects missing modelDefinitionId
CreatePriceRuleDto rejects missing modelDefinitionId
vehicleModel is stripped/rejected by validation
VehicleModelDefinition DTO has no legacyVehicleModel property
quote/order creation writes all three canonical snapshots
```

- [ ] **Step 2: 运行 focused tests确认RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model.spec.ts test/product-components.spec.ts test/vehicle-model-definition.spec.ts test/quote-order-model-snapshot.spec.ts test/order-contract.spec.ts
```

- [ ] **Step 3: 修改DTO**

For create DTOs, use:

```ts
@IsUUID("4")
modelDefinitionId!: string;
```

Remove `vehicleModel`, `legacyVehicleModel`, their validators, and model-code free-text constants. Update DTOs may accept only `modelDefinitionId?: string` where model reassignment is an existing allowed operation.

- [ ] **Step 4: 修改领域写入**

For vehicle, package, price rule, quote, and order writes:

```ts
const identity = await requireActiveVehicleModelDefinition(
  this.prisma,
  dto.modelDefinitionId
);

const snapshot = buildVehicleModelSnapshot(identity);
```

Persist only `modelDefinitionId` on current entities and `snapshot` on Quote/Order. Remove legacy mismatch and fallback branches.

- [ ] **Step 5: 修改车型主数据服务**

Remove:

```text
assertLegacyVehicleModelAvailable
legacyVehicleModel create/update/select/filter logic
legacy alias conflict checks
```

Keep `modelCode` uniqueness and immutability.

- [ ] **Step 6: 运行focused tests及类型检查**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model.spec.ts test/product-components.spec.ts test/vehicle-model-definition.spec.ts test/quote-order-model-snapshot.spec.ts test/order-contract.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: focused tests pass; remaining errors are read-contract consumers handled next.

- [ ] **Step 7: 提交写路径**

```powershell
git add apps/api/src/vehicle/dto/vehicle.dto.ts apps/api/src/product/dto/product.dto.ts apps/api/src/vehicle-model-definition/dto/vehicle-model-definition.dto.ts apps/api/src/vehicle/vehicle.service.ts apps/api/src/product/product.service.ts apps/api/src/order/order.service.ts apps/api/src/vehicle-model-definition/vehicle-model-definition.service.ts apps/api/test/vehicle-model.spec.ts apps/api/test/product-components.spec.ts apps/api/test/vehicle-model-definition.spec.ts apps/api/test/quote-order-model-snapshot.spec.ts apps/api/test/order-contract.spec.ts
git commit -m "refactor(vehicle): require model definition writes"
```

### Task 5: 收敛读取API、Portal和后台页面

**Files:**
- Modify: `apps/api/src/portal/portal-catalog.dto.ts`
- Modify: `apps/api/src/portal/portal-catalog.service.ts`
- Modify: `apps/web/src/lib/portal-types.ts`
- Modify: `apps/web/src/app/vehicle-model-definitions/page.tsx`
- Modify: `apps/web/src/app/vehicles/page.tsx`
- Modify: `apps/web/src/app/products/page.tsx`
- Test: `apps/api/test/portal-catalog.spec.ts`
- Test: `apps/api/test/vehicle-listing.spec.ts`
- Test: `apps/web/test/product-center-access.spec.ts`

**Interfaces:**
- Consumes: canonical current-entity identity and quote/order snapshots.
- Produces: API/UI contract with only `modelDefinitionId`, `modelCode`, and `modelDisplayName`.

- [ ] **Step 1: 写失败契约测试**

Assert response objects:

```ts
expect(row).toMatchObject({
  modelDefinitionId: "definition-id",
  modelCode: "MODEL_X_2027",
  modelDisplayName: "Model X 2027"
});
expect(row).not.toHaveProperty("vehicleModel");
expect(row).not.toHaveProperty("legacyVehicleModel");
```

Assert Portal shared types and Admin forms have no legacy fields or free-text model code input.

- [ ] **Step 2: 运行测试确认RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-catalog.spec.ts test/vehicle-listing.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/product-center-access.spec.ts
```

- [ ] **Step 3: 修改API读取契约**

Build current model output only from the related definition:

```ts
{
  modelDefinitionId: row.modelDefinition.id,
  modelCode: row.modelDefinition.modelCode,
  modelDisplayName: row.modelDefinition.displayName
}
```

Remove legacy compatibility fields and filters.

- [ ] **Step 4: 修改Portal和后台**

Use `modelDefinitionId` as selection value and render:

```text
modelDisplayName (modelCode)
```

Remove enum selectors, compatibility badges, legacy columns, and fallback display.

- [ ] **Step 5: 运行测试与Web类型检查**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/portal-catalog.spec.ts test/vehicle-listing.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/product-center-access.spec.ts
pnpm --filter @subscription-saas/web typecheck
```

- [ ] **Step 6: 提交读取契约**

```powershell
git add apps/api/src/portal/portal-catalog.dto.ts apps/api/src/portal/portal-catalog.service.ts apps/web/src/lib/portal-types.ts apps/web/src/app/vehicle-model-definitions/page.tsx apps/web/src/app/vehicles/page.tsx apps/web/src/app/products/page.tsx apps/api/test/portal-catalog.spec.ts apps/api/test/vehicle-listing.spec.ts apps/web/test/product-center-access.spec.ts
git commit -m "refactor(portal): remove legacy vehicle model contracts"
```

### Task 6: 收敛报表、残值及CSV契约

**Files:**
- Modify: `apps/api/src/report/dto/report.dto.ts`
- Modify: `apps/api/src/report/report.service.ts`
- Modify: `apps/api/src/residual-market/residual-market.service.ts`
- Modify: `apps/api/src/vehicle-valuation-review/vehicle-valuation-review.service.ts`
- Modify: `apps/web/src/app/reports/page.tsx`
- Modify: `apps/web/src/app/reports/asset-profitability/page.tsx`
- Modify: `apps/web/src/app/residual-market/page.tsx`
- Test: `apps/api/test/report.spec.ts`
- Test: `apps/api/test/residual-market.spec.ts`
- Test: `apps/api/test/vehicle-valuation-review.spec.ts`

**Interfaces:**
- Consumes: `modelDefinitionId`, `modelCode`, and display name only.
- Produces: canonical report filters and CSV columns without legacy model names.

- [ ] **Step 1: 写失败报表测试**

Assert:

```text
report filters accept modelDefinitionId and reject vehicleModel
CSV contains modelCode and modelDisplayName
CSV does not contain vehicleModel, legacyVehicleModel, or legacy snapshots
residual and valuation outputs use model-definition identity
```

- [ ] **Step 2: 运行测试确认RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/report.spec.ts test/residual-market.spec.ts test/vehicle-valuation-review.spec.ts
```

- [ ] **Step 3: 修改DTO和服务**

Replace every vehicle-model compatibility filter with:

```ts
@IsOptional()
@IsUUID("4")
modelDefinitionId?: string;
```

Join or select `{ id, modelCode, displayName }` and remove alias comparison.

- [ ] **Step 4: 修改Web筛选和CSV展示**

Selectors send `modelDefinitionId`. CSV and UI labels use `modelCode` and `modelDisplayName`.

- [ ] **Step 5: 运行测试与类型检查**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/report.spec.ts test/residual-market.spec.ts test/vehicle-valuation-review.spec.ts
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/web typecheck
```

- [ ] **Step 6: 提交报表契约**

Stage the exact files above and commit:

```powershell
git commit -m "refactor(report): use canonical vehicle model fields"
```

### Task 7: 更新种子、测试夹具、治理和外部契约登记

**Files:**
- Modify: `apps/api/prisma/seed.mjs`
- Modify: `apps/api/prisma/seed-scenario.mjs`
- Modify: `apps/api/prisma/seed-vehicle-model.mjs`
- Modify: `apps/api/test/helpers/vehicle-model-codes.ts`
- Modify: `apps/api/test/application-review-api.spec.ts`
- Modify: `apps/api/test/capital-structure.spec.ts`
- Modify: `apps/api/test/customer-order.spec.ts`
- Modify: `apps/api/test/order-ab-model.spec.ts`
- Modify: `apps/api/test/order-change-execute.spec.ts`
- Modify: `apps/api/test/order-contract.spec.ts`
- Modify: `apps/api/test/order-review.spec.ts`
- Modify: `apps/api/test/portal-application.spec.ts`
- Modify: `apps/api/test/portal-catalog.spec.ts`
- Modify: `apps/api/test/portal-order-billing.spec.ts`
- Modify: `apps/api/test/product-components.spec.ts`
- Modify: `apps/api/test/quote-order-model-snapshot.spec.ts`
- Modify: `apps/api/test/report.spec.ts`
- Modify: `apps/api/test/residual-market.spec.ts`
- Modify: `apps/api/test/revenue-right.spec.ts`
- Modify: `apps/api/test/seed-customer-order.spec.ts`
- Modify: `apps/api/test/self-service-application.spec.ts`
- Modify: `apps/api/test/subscription-plan.spec.ts`
- Modify: `apps/api/test/vehicle-listing.spec.ts`
- Modify: `apps/api/test/vehicle-model-definition.spec.ts`
- Modify: `apps/api/test/vehicle-model-enum-string-schema.spec.ts`
- Modify: `apps/api/test/vehicle-model-integration.spec.ts`
- Modify: `apps/api/test/vehicle-model-resolver.spec.ts`
- Modify: `apps/api/test/vehicle-model.spec.ts`
- Modify: `apps/api/test/vehicle-sale-price.spec.ts`
- Modify: `apps/api/test/vehicle-valuation-review.spec.ts`
- Modify: `docs/vehicle-model-external-contract-consumer-register.json`
- Modify: `docs/stage-10x-vehicle-model-final-zero-risk-decommission.md`
- Modify: `docs/stage-10x-vehicle-model-schema-final-removal-preparation.md`
- Modify: `scripts/vehicle-model-removal-readiness-core.mjs`
- Modify: `scripts/vehicle-model-removal-readiness-core.test.mjs`

**Interfaces:**
- Consumes: final canonical schema and API.
- Produces: direct canonical seeds, fixtures, zero external compatibility consumers, and `hardRemovalReady=true`.

- [ ] **Step 1: 运行无兼容字段守卫确认剩余引用**

```powershell
node scripts/check-vehicle-model-no-compatibility.mjs
```

Expected: FAIL with an explicit file/category list.

- [ ] **Step 2: 修改种子**

Create definitions first and connect by ID:

```js
modelDefinition: {
  connect: { id: modelDefinitionByCode.get("ET5").id }
}
```

Quote/order seed snapshots use:

```js
modelDefinitionIdSnapshot: definition.id,
modelCodeSnapshot: definition.modelCode,
modelDisplayNameSnapshot: definition.displayName
```

No seed writes a removed field.

- [ ] **Step 3: 修改测试夹具**

Replace enum/legacy fixtures with canonical identities:

```ts
export const TEST_MODEL = {
  id: "00000000-0000-4000-8000-000000000051",
  modelCode: "ET5",
  displayName: "蔚来 ET5"
} as const;
```

Tests must build relationships by ID and assert canonical snapshots.

- [ ] **Step 4: 更新治理**

The external contract register contains no active legacy consumers. Removal readiness must return:

```json
{
  "decision": "READY",
  "enumUsageCount": 0,
  "externalUsageCount": 0,
  "fallbackUsageCount": 0,
  "readinessScore": 100
}
```

Contract governance must return `hardRemovalReady=true`.

- [ ] **Step 5: 运行脚本和守卫测试**

```powershell
node --test scripts/check-vehicle-model-no-compatibility.test.mjs
node scripts/check-vehicle-model-no-compatibility.mjs
pnpm vehicle-model:removal-readiness:test
pnpm vehicle-model:removal-readiness
pnpm vehicle-model:contract-governance
```

Expected: all pass with zero compatibility consumers.

- [ ] **Step 6: 提交种子和治理**

Stage explicit modified seed, test, script, registry, and governance-document files. Commit:

```powershell
git commit -m "chore(vehicle): retire model compatibility governance"
```

### Task 8: 在全新数据库验证阶段0最终Schema

**Files:**
- Verify: all migrations and seeds
- Evidence: Stage0 verification document

**Interfaces:**
- Consumes: completed Tasks 1-7 and approved database name `subscription_saas_stage0b_verify`.
- Produces: fresh final database with no enum or compatibility columns.

- [ ] **Step 1: 创建独立验证库**

Create exactly:

```text
subscription_saas_stage0b_verify
```

Point the worktree `DATABASE_URL` to it through secret management. Do not reuse `subscription_saas_stage0a_verify` and do not print credentials.

- [ ] **Step 2: 部署完整迁移链**

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate deploy --schema prisma/schema.prisma
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Expected: all migrations apply and status is up to date.

- [ ] **Step 3: 验证数据库对象**

Run:

```sql
SELECT EXISTS (
  SELECT 1 FROM pg_type WHERE typname = 'vehicle_model'
) AS vehicle_model_enum_exists;

SELECT table_name, column_name
FROM information_schema.columns
WHERE column_name IN (
  'vehicle_model',
  'legacy_vehicle_model',
  'legacy_vehicle_model_snapshot',
  'legacy_vehicle_model_code_snapshot'
)
ORDER BY table_name, column_name;

SELECT table_name, column_name, is_nullable
FROM information_schema.columns
WHERE (table_name, column_name) IN (
  ('vehicle', 'model_definition_id'),
  ('vehicle_package', 'model_definition_id'),
  ('product_price_rule', 'model_definition_id'),
  ('subscription_quote', 'model_definition_id_snapshot'),
  ('subscription_quote', 'model_code_snapshot'),
  ('subscription_quote', 'model_display_name_snapshot'),
  ('subscription_order', 'model_definition_id_snapshot'),
  ('subscription_order', 'model_code_snapshot'),
  ('subscription_order', 'model_display_name_snapshot')
)
ORDER BY table_name, column_name;
```

Expected:

```text
vehicle_model_enum_exists = false
legacy column query returns zero rows
all listed canonical references/snapshots have is_nullable = NO
```

- [ ] **Step 4: 运行种子两次**

```powershell
pnpm --filter @subscription-saas/api exec prisma db seed
pnpm --filter @subscription-saas/api exec prisma db seed
```

Expected: both pass without duplicates or compatibility writes.

- [ ] **Step 5: 运行车型主路径测试**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model-definition.spec.ts test/vehicle-model.spec.ts test/product-components.spec.ts test/quote-order-model-snapshot.spec.ts test/order-contract.spec.ts test/portal-catalog.spec.ts test/report.spec.ts test/residual-market.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/product-center-access.spec.ts
```

Expected: PASS.

### Task 9: 完整验证、验收记录和最终提交

**Files:**
- Verify all changed files
- Create: `docs/stage-0-vehicle-model-clean-initialization-verification.md`

**Interfaces:**
- Consumes: completed Stage0B branch.
- Produces: implementation-ready final schema evidence and clean branch.

- [ ] **Step 1: 运行Prisma和守卫**

```powershell
pnpm prisma:validate
pnpm prisma:generate
node scripts/check-vehicle-model-no-enum.mjs
node scripts/check-vehicle-model-no-compatibility.mjs
```

Expected: all pass.

- [ ] **Step 2: 运行API全量门禁**

```powershell
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/api build
```

- [ ] **Step 3: 运行Web全量门禁**

```powershell
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web test
pnpm --filter @subscription-saas/web build
```

- [ ] **Step 4: 运行发布和迁移状态检查**

Keep `DATABASE_URL` on `subscription_saas_stage0b_verify`:

```powershell
pnpm release:check
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Expected: PASS and database up to date.

- [ ] **Step 5: 编写验收记录**

The document must record:

```text
Stage0A base commit
Stage0B head commit
verification database name
migration count and status
enum existence query
legacy column query
canonical NOT NULL query
seed first/second run
focused/full test results
readiness and hardRemovalReady outputs
known non-goals
```

Do not include credentials.

- [ ] **Step 6: 运行最终安全检查**

```powershell
git diff --check
git status --short --branch --untracked-files=all
git diff --name-status main...HEAD
git diff main...HEAD -- package.json pnpm-lock.yaml
git diff main...HEAD -- apps/api/src/finance apps/api/src/billing apps/api/src/lease apps/api/src/esign
```

Expected: no unintended dependency, lockfile, finance, billing, lease, or eSign change.

- [ ] **Step 7: 提交验收记录**

```powershell
git add docs/stage-0-vehicle-model-clean-initialization-verification.md
git commit -m "docs(vehicle): record clean model initialization verification"
```

Do not push until requested.
