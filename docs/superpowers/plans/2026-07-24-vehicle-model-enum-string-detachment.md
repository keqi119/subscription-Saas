# VehicleModel Enum String Detachment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert all VehicleModel enum columns to strings, remove the Prisma/PostgreSQL enum, and make canonical model-code writes derive from VehicleModelDefinition.modelCode.

**Architecture:** Keep database column names and JSON compatibility values stable while replacing enum typing with validated strings. Canonical writes remain modelDefinitionId-first; compatibility columns remain temporary read surfaces until a later coverage-gated removal phase.

**Tech Stack:** NestJS, Prisma, PostgreSQL, Next.js, TypeScript, Vitest, Node test runner, pnpm.

## Global Constraints

- No staging or production database writes.
- No `prisma db push` or `prisma migrate reset`.
- No finance, billing, lease, eSign, contract, delivery, or payment behavior changes.
- No package or lockfile changes and no new dependencies.
- Use explicit Prisma migration SQL.
- Preserve existing model-code values and API/CSV output semantics.
- Implement each behavior with a failing test first.

---

### Task 1: Schema Contract And No-Enum Guard

**Files:**
- Create: `apps/api/test/vehicle-model-enum-string-schema.spec.ts`
- Create: `scripts/check-vehicle-model-no-enum.mjs`
- Create: `scripts/check-vehicle-model-no-enum.test.mjs`
- Modify: `scripts/release-check.mjs`

**Interfaces:**
- Produces: `assertVehicleModelEnumRemoved(schemaText, runtimeFiles)` used by the CLI guard.
- Consumes: Prisma schema text and runtime source files.

- [ ] **Step 1: Write failing schema and guard tests**

Assert:

```text
enum VehicleModel is absent
all eight former enum fields are String/String?
migration casts all eight columns before DROP TYPE
guard rejects an enum block, an enum-typed field, and a Prisma VehicleModel import
guard accepts string compatibility fields
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model-enum-string-schema.spec.ts
node --test scripts/check-vehicle-model-no-enum.test.mjs
```

Expected: FAIL because the enum and old freeze guard still exist.

- [ ] **Step 3: Implement the no-enum guard**

The CLI scans:

```text
apps/api/prisma/schema.prisma
apps/api/src
apps/web/src
packages/shared/src
scripts excluding only the guard's own implementation/tests
```

It exits non-zero for schema/runtime enum dependencies and prints only file
paths and dependency categories.

- [ ] **Step 4: Replace release freeze entry**

Replace `vehicle-model:enum-freeze` release checks with
direct execution of `scripts/check-vehicle-model-no-enum.mjs` and its Node
tests. Do not modify package scripts.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/test/vehicle-model-enum-string-schema.spec.ts scripts/check-vehicle-model-no-enum.mjs scripts/check-vehicle-model-no-enum.test.mjs scripts/release-check.mjs
git commit -m "test(vehicle): define vehicle model enum removal contract"
```

### Task 2: Prisma String Conversion Migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260724170000_vehicle_model_enum_to_string/migration.sql`

**Interfaces:**
- Produces: Prisma string fields with unchanged database column names.
- Consumes: existing PostgreSQL `vehicle_model` enum values.

- [ ] **Step 1: Run the schema test and confirm RED**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model-enum-string-schema.spec.ts
```

Expected: enum/schema assertions fail.

- [ ] **Step 2: Convert the eight Prisma fields**

Use `String`/`String?` with `@db.VarChar(64)` and keep existing `@map`
attributes, indexes, and constraints.

- [ ] **Step 3: Add explicit SQL migration**

For each known column:

```sql
BEGIN;

ALTER TABLE "<table>"
  ALTER COLUMN "<column>" TYPE VARCHAR(64)
  USING "<column>"::text;

-- Repeat the ALTER TABLE conversion for all eight known columns.

DROP TYPE "vehicle_model";

COMMIT;
```

- [ ] **Step 4: Validate schema**

Run:

```powershell
pnpm prisma:validate
pnpm prisma:generate
```

Expected: both pass after runtime type work in subsequent tasks; if generate
passes before typecheck, proceed.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260724170000_vehicle_model_enum_to_string/migration.sql
git commit -m "refactor(vehicle): convert vehicle model enum columns to strings"
```

### Task 3: Resolver, Snapshot, And Runtime Type Detachment

**Files:**
- Modify: `apps/api/src/common/vehicle-model-resolver.ts`
- Modify: `apps/api/src/common/vehicle-model-snapshot.ts`
- Modify: `apps/api/src/vehicle/vehicle.service.ts`
- Modify: `apps/api/src/vehicle/vehicle-listing.service.ts`
- Modify: `apps/api/src/product/product.service.ts`
- Modify: `apps/api/src/order/order.service.ts`
- Modify: `apps/api/src/report/report.service.ts`
- Modify: `apps/api/src/portal/portal-catalog.service.ts`
- Modify: `apps/api/src/vehicle-model-definition/vehicle-model-definition.service.ts`
- Modify: `apps/api/src/residual-market/residual-market.service.ts`
- Modify: `apps/api/src/vehicle-valuation-review/vehicle-valuation-review.service.ts`
- Test: `apps/api/test/vehicle-model-resolver.spec.ts`
- Test: `apps/api/test/quote-order-model-snapshot.spec.ts`
- Test: `apps/api/test/vehicle-model.spec.ts`
- Test: `apps/api/test/vehicle-model-integration.spec.ts`
- Test: `apps/api/test/product-components.spec.ts`
- Test: `apps/api/test/product-quote.spec.ts`
- Test: `apps/api/test/portal-catalog.spec.ts`
- Test: `apps/api/test/report.spec.ts`

**Interfaces:**
- Produces: `VehicleModelCode = string` semantics derived from `modelCode`.
- Consumes: `modelDefinitionId`, related VehicleModelDefinition, and string compatibility snapshots.

- [ ] **Step 1: Add failing resolver tests**

Cover a canonical model code such as `MODEL_X_2027` that never existed in the
old enum. Assert modelDefinitionId-first resolution and snapshot display work.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model-resolver.spec.ts test/quote-order-model-snapshot.spec.ts
```

- [ ] **Step 3: Replace Prisma enum types with strings**

Rules:

```text
modelDefinition.modelCode is the compatibility code for new writes
legacy-only writes remain rejected
existing vehicleModel strings remain readable
snapshot code strings are preferred for historical display
no runtime source imports VehicleModel
```

- [ ] **Step 4: Run API typecheck and focused tests**

```powershell
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model-resolver.spec.ts test/quote-order-model-snapshot.spec.ts test/vehicle-model.spec.ts test/vehicle-model-integration.spec.ts
```

- [ ] **Step 5: Commit**

Stage explicit changed files and commit:

```powershell
git commit -m "refactor(vehicle): detach runtime model codes from prisma enum"
```

### Task 4: DTO And Admin Legacy-Control Removal

**Files:**
- Modify: `apps/api/src/vehicle/dto/vehicle.dto.ts`
- Modify: `apps/api/src/product/dto/product.dto.ts`
- Modify: `apps/api/src/report/dto/report.dto.ts`
- Modify: `apps/api/src/portal/portal-catalog.dto.ts`
- Modify: `apps/api/src/vehicle-model-definition/dto/vehicle-model-definition.dto.ts`
- Modify: `apps/web/src/app/vehicle-model-definitions/page.tsx`
- Modify: `apps/web/src/app/vehicles/page.tsx`
- Modify: `apps/web/src/app/products/page.tsx`
- Test: `apps/api/test/vehicle-model-definition.spec.ts`
- Test: `apps/api/test/vehicle-model.spec.ts`
- Test: `apps/api/test/product-components.spec.ts`
- Test: `apps/api/test/portal-catalog.spec.ts`
- Test: `apps/api/test/report.spec.ts`
- Test: `apps/web/test/product-center-access.spec.ts`

**Interfaces:**
- Produces: modelDefinitionId-first forms and validated string compatibility filters.
- Consumes: VehicleModelDefinition options using `id`, `modelCode`, and display names.
- Enforces: `modelCode` is immutable after creation and read-only in Admin edit flows.

- [ ] **Step 1: Write failing tests**

Assert:

```text
no fixed VehicleModel enum options are rendered
VehicleModelDefinition form has no legacy enum input
Vehicle/Product model changes require modelDefinitionId
remaining deprecated filters validate a 64-character model-code string
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model-definition.spec.ts test/vehicle-model.spec.ts test/product-components.spec.ts test/portal-catalog.spec.ts test/report.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/product-center-access.spec.ts
```

- [ ] **Step 3: Remove editable legacy controls**

Do not replace the fixed enum selector with a free-text business input.
Canonical model-definition selection remains the only editable path.

- [ ] **Step 4: Verify focused tests and typechecks**

```powershell
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/web typecheck
```

- [ ] **Step 5: Commit**

```powershell
git commit -m "refactor(admin): remove legacy vehicle model controls"
```

### Task 5: Seeds, Backfills, Governance, And Regression Updates

**Files:**
- Modify: `apps/api/prisma/seed.mjs`
- Modify: `apps/api/prisma/seed-scenario.mjs`
- Modify: `scripts/check-vehicle-model-enum-freeze.mjs`
- Modify: `scripts/check-vehicle-model-enum-freeze.test.mjs`
- Modify: `scripts/model-definition-backfill.mjs`
- Modify: `scripts/model-definition-backfill-core.mjs`
- Modify: `scripts/model-definition-backfill-core.test.mjs`
- Modify: `scripts/quote-order-model-snapshot-backfill.mjs`
- Modify: `scripts/quote-order-model-snapshot-backfill-core.mjs`
- Modify: `scripts/quote-order-model-snapshot-backfill-core.test.mjs`
- Modify: `scripts/quote-order-model-code-snapshot-backfill.mjs`
- Modify: `scripts/quote-order-model-code-snapshot-backfill-core.mjs`
- Modify: `scripts/quote-order-model-code-snapshot-backfill-core.test.mjs`
- Modify: `scripts/vehicle-model-removal-readiness-core.mjs`
- Modify: `scripts/vehicle-model-removal-readiness-core.test.mjs`
- Modify: `docs/vehicle-model-external-contract-consumer-register.json`
- Modify: `docs/stage-10x-vehicle-model-enum-freeze-guard.md`
- Modify: `docs/stage-10x-vehicle-model-final-zero-risk-decommission.md`
- Modify: `docs/stage-10x-vehicle-model-schema-final-removal-preparation.md`

**Interfaces:**
- Produces: string-code fixtures and no-enum release governance.
- Consumes: canonical VehicleModelDefinition records.

- [ ] **Step 1: Run the no-enum guard and verify remaining failures**

```powershell
node scripts/check-vehicle-model-no-enum.mjs
```

- [ ] **Step 2: Convert fixtures and scripts to strings**

Keep migration/backfill historical semantics, but remove generated Prisma enum
imports and frozen enum assumptions.

- [ ] **Step 3: Update governance semantics**

Enum removal readiness checks the absence of schema/runtime enum dependencies.
External compatibility-field retirement remains governed separately and must
not block this lossless type conversion.

- [ ] **Step 4: Run script tests**

```powershell
node --test scripts/check-vehicle-model-no-enum.test.mjs
pnpm vehicle-model:removal-readiness:test
pnpm vehicle-model:contract-governance
```

- [ ] **Step 5: Commit**

```powershell
git commit -m "chore(vehicle): replace enum freeze with string-code governance"
```

### Task 6: Full Verification And Safety Audit

**Files:**
- Verify all changed files.

**Interfaces:**
- Consumes: completed Tasks 1-5.
- Produces: merge-ready branch with clean worktree.

- [ ] **Step 1: Run Prisma checks**

```powershell
pnpm prisma:validate
pnpm prisma:generate
```

- [ ] **Step 2: Run API checks**

```powershell
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/api build
```

- [ ] **Step 3: Run Web checks**

```powershell
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web test
pnpm --filter @subscription-saas/web build
```

- [ ] **Step 4: Run governance and release checks**

```powershell
node scripts/check-vehicle-model-no-enum.mjs
pnpm release:check
```

- [ ] **Step 5: Run safety checks**

```powershell
git diff --check
git status --short --branch --untracked-files=all
git diff --name-status origin/main...HEAD
git diff -- package.json pnpm-lock.yaml
git diff -- apps/api/src/finance apps/api/src/billing apps/api/src/lease apps/api/src/esign
```

Confirm no dependency, lockfile, finance, billing, lease, eSign, delivery, or
environment changes.

- [ ] **Step 6: Final local commit**

Stage explicit files only. Do not push until requested.
