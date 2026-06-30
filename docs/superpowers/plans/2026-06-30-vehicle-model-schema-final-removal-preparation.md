# VehicleModel Schema Final Removal Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the final schema-removal workstream for the frozen `VehicleModel` enum without changing schema or runtime behavior in the preparation stage.

**Architecture:** Treat enum removal as a gated migration program, not a single schema edit. The plan requires evidence-driven gates, contract migration, production-like clone rehearsals, and rollback rehearsals before any destructive schema migration.

**Tech Stack:** Prisma schema and migrations, NestJS API contracts, report/CSV exports, `VehicleModelUsageTracker`, `vehicle-model:removal-readiness`, `vehicle-model:contract-governance`, pnpm release checks.

---

## File Structure

- Primary preparation doc: `docs/stage-10x-vehicle-model-schema-final-removal-preparation.md`
- Execution handoff: `docs/superpowers/plans/2026-06-30-vehicle-model-schema-final-removal-preparation.md`
- Future schema isolation report: `docs/vehicle-model-schema-dependency-isolation-report.md`
- Future rollback runbook: `docs/vehicle-model-enum-removal-rollback-runbook.md`
- Future migration rehearsal report: `docs/vehicle-model-enum-removal-dry-run-report.md`
- Future schema target: `apps/api/prisma/schema.prisma`
- Future migration target: `apps/api/prisma/migrations/*`

## Task 1: Produce Schema Dependency Isolation Report

**Files:**
- Create: `docs/vehicle-model-schema-dependency-isolation-report.md`
- Read: `apps/api/prisma/schema.prisma`
- Test: `pnpm vehicle-model:removal-readiness`, `pnpm vehicle-model:contract-governance`

- [ ] **Step 1: Create the isolation report**

Create `docs/vehicle-model-schema-dependency-isolation-report.md` with this content:

```markdown
# VehicleModel Schema Dependency Isolation Report

## Current Enum-Typed Fields

| Model | Field | Target before removal | Owner | Status |
| --- | --- | --- | --- | --- |
| Vehicle | vehicleModel | modelDefinitionId + optional string compatibility field | Operations | Not ready |
| VehicleModelDefinition | legacyVehicleModel | modelCode / legacyVehicleModelCode String? or removed mapping | Platform | Not ready |
| VehiclePackage | vehicleModel | modelDefinitionId | Product | Not ready |
| ProductPriceRule | vehicleModel | modelDefinitionId uniqueness and lookup | Product | Not ready |
| SubscriptionQuote | vehicleModel | modelDefinitionIdSnapshot / modelDisplayNameSnapshot / legacyVehicleModelCodeSnapshot | Product | Not ready |
| SubscriptionQuote | legacyVehicleModelSnapshot | legacyVehicleModelCodeSnapshot | Product | Not ready |
| SubscriptionOrder | vehicleModel | modelDefinitionIdSnapshot / modelDisplayNameSnapshot / legacyVehicleModelCodeSnapshot | Order | Not ready |
| SubscriptionOrder | legacyVehicleModelSnapshot | legacyVehicleModelCodeSnapshot | Order | Not ready |

## Isolation Gate

```text
Every row must be Ready before enum deletion work begins.
```

## Required Evidence

```text
pnpm vehicle-model:removal-readiness => decision READY
pnpm vehicle-model:contract-governance => hardRemovalReady true
ProductPriceRule uniqueness migrated to modelDefinitionId
Quote / Order historical display verified from string snapshots
Reports and CSV v2 samples verified
```
```

- [ ] **Step 2: Run evidence commands**

Run:

```powershell
pnpm vehicle-model:removal-readiness
pnpm vehicle-model:contract-governance
```

Expected before final removal:

```text
removal readiness decision is READY
contract governance hardRemovalReady is true
```

If either command is not ready, document the blockers and stop.

- [ ] **Step 3: Commit report**

Run:

```powershell
git add docs/vehicle-model-schema-dependency-isolation-report.md
git commit -m "docs: add vehicle model schema dependency isolation report"
```

## Task 2: Prepare ProductPriceRule Uniqueness Migration Design

**Files:**
- Create: `docs/vehicle-model-product-price-rule-uniqueness-migration.md`
- Future modify: `apps/api/prisma/schema.prisma`
- Future modify: `apps/api/src/product/product.service.ts`
- Test: product quote and price-rule tests

- [ ] **Step 1: Create migration design**

Create `docs/vehicle-model-product-price-rule-uniqueness-migration.md` with this content:

```markdown
# ProductPriceRule modelDefinitionId Uniqueness Migration

## Goal

Move ProductPriceRule uniqueness and lookup from `vehicleModel` to `modelDefinitionId`.

## Current Risk

```text
@@unique([productVersionId, vehicleModel])
```

blocks enum removal because pricing uniqueness still depends on `VehicleModel`.

## Target

```text
@@unique([productVersionId, modelDefinitionId])
```

## Required Tests

```text
direct quote uses modelDefinitionId
legacy vehicleModel input is rejected or converted before lookup
duplicate productVersionId + modelDefinitionId is rejected
historical rules remain readable
```

## Rollback

```text
keep old selector available until all callers move
revert application lookup before rolling back database uniqueness
```
```

- [ ] **Step 2: Add acceptance criteria to Stage 10X-V**

Append to `docs/stage-10x-vehicle-model-schema-final-removal-preparation.md`:

```markdown
ProductPriceRule enum removal is blocked until `productVersionId + modelDefinitionId` is the enforced uniqueness rule and quote pricing tests pass without enum selectors.
```

- [ ] **Step 3: Commit design**

Run:

```powershell
git add docs/vehicle-model-product-price-rule-uniqueness-migration.md docs/stage-10x-vehicle-model-schema-final-removal-preparation.md
git commit -m "docs: design product price rule model definition uniqueness migration"
```

## Task 3: Prepare Rollback Runbook

**Files:**
- Create: `docs/vehicle-model-enum-removal-rollback-runbook.md`
- Test: documentation review plus release checks

- [ ] **Step 1: Create rollback runbook**

Create `docs/vehicle-model-enum-removal-rollback-runbook.md` with this content:

```markdown
# VehicleModel Enum Removal Rollback Runbook

## Pre-removal Assets

```text
database backup
previous application image
schema migration down rehearsal notes
API compatibility samples
CSV baseline samples
pricing comparison samples
```

## Application Rollback

```text
rollback application deployment first
verify old app can read current schema
restore v1 API or CSV contract if consumers fail
```

## Schema Rollback

```text
only execute rehearsed down migration or restore backup
never recreate enum ad hoc in production
pause all enum-removal work after rollback
```

## Smoke Checks

```text
quote pricing unchanged
order details readable
asset profitability report row count unchanged
CSV model display fields present
Quote / Order historical snapshots readable
```
```

- [ ] **Step 2: Add rollback owners**

Add owner rows:

```markdown
| Area | Owner | Required during rollback |
| --- | --- | --- |
| Database | Platform owner | backup restore / down migration |
| API | Backend owner | compatibility routes |
| Reports / CSV | Finance owner | sample comparison |
| Quote / Order | Product owner | historical display verification |
```

- [ ] **Step 3: Commit runbook**

Run:

```powershell
git add docs/vehicle-model-enum-removal-rollback-runbook.md
git commit -m "docs: add vehicle model enum removal rollback runbook"
```

## Task 4: Prepare Production-Like Dry-Run Checklist

**Files:**
- Create: `docs/vehicle-model-enum-removal-dry-run-report.md`
- Test: dry-run commands only, no production execution

- [ ] **Step 1: Create dry-run report template**

Create `docs/vehicle-model-enum-removal-dry-run-report.md` with this content:

```markdown
# VehicleModel Enum Removal Dry-Run Report

## Environment

```text
database clone:
application commit:
migration branch:
operator:
date:
```

## Preflight

```text
pnpm vehicle-model:removal-readiness
pnpm vehicle-model:contract-governance
pnpm release:check
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

## Migration Rehearsal

```text
prisma migrate deploy against clone
prisma validate/generate
API tests
report CSV sample comparison
pricing sample comparison
rollback rehearsal
```

## Result

```text
READY / NOT READY
blockers:
rollback validated: yes/no
```
```

- [ ] **Step 2: Commit dry-run template**

Run:

```powershell
git add docs/vehicle-model-enum-removal-dry-run-report.md
git commit -m "docs: add vehicle model enum removal dry-run template"
```

## Task 5: Final Verification

**Files:**
- Modify: `README.md`
- Test: release checks

- [ ] **Step 1: Update README**

Add:

```markdown
- `docs/stage-10x-vehicle-model-schema-final-removal-preparation.md`: Stage 10X-U-C VehicleModel schema final removal preparation covering deletion sequence, Prisma migration strategy, rollback, safety gates, production cutover, and risk analysis.
```

- [ ] **Step 2: Run verification**

Run:

```powershell
pnpm vehicle-model:removal-readiness
pnpm vehicle-model:contract-governance
pnpm release:check
```

Expected:

```text
readiness and governance commands produce current gate status
release check passes
```

- [ ] **Step 3: Commit README**

Run:

```powershell
git add README.md
git commit -m "docs: reference vehicle model schema final removal preparation"
```

## Self-Review Checklist

- [ ] Schema removal execution plan includes safe deletion steps, Prisma migration strategy, and backward compatibility constraints.
- [ ] Rollback strategy covers schema rollback, report/CSV fallback, and API contract fallback.
- [ ] Final safety gate requires external, fallback, and business usage to be zero.
- [ ] Production cutover plan includes migration window, zero-downtime constraints, and dual-read fallback phase.
- [ ] Risk analysis covers report system, CSV export, and historical data inconsistency risks.
- [ ] No task requires schema changes, migration execution, enum deletion, production deployment, or data modification in Stage 10X-U-C.
