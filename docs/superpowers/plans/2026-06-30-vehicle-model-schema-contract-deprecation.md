# VehicleModel Schema Contract Deprecation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `VehicleModel` API / CSV / external contracts through soft deprecation and warning mode without schema changes or business behavior changes.

**Architecture:** Keep `modelDefinitionId` and snapshot fields as canonical while `vehicleModel` remains a compatibility contract. Use runtime evidence, consumer inventory, documentation, and warning-mode gates before any later schema migration is considered.

**Tech Stack:** NestJS DTOs, Prisma schema documentation, Next.js report pages, CSV exports, `VehicleModelUsageTracker`, `vehicle-model-removal-readiness` script, pnpm release checks.

---

## File Structure

- Primary plan: `docs/stage-10x-vehicle-model-schema-contract-deprecation-plan.md`
- Execution handoff: `docs/superpowers/plans/2026-06-30-vehicle-model-schema-contract-deprecation.md`
- Future API docs updates: `apps/api/src/product/dto/product.dto.ts`, `apps/api/src/report/dto/report.dto.ts`, `apps/api/src/vehicle/dto/vehicle.dto.ts`, `apps/api/src/vehicle-model-definition/dto/vehicle-model-definition.dto.ts`
- Future warning-mode instrumentation: `apps/api/src/common/vehicle-model-usage-tracker.ts`
- Future CSV docs: `docs/reporting-metrics.md`

## Task 1: Contract Inventory Register

**Files:**
- Create: `docs/vehicle-model-contract-consumer-register.md`
- Modify: `docs/stage-10x-vehicle-model-schema-contract-deprecation-plan.md`

- [ ] **Step 1: Create the consumer register**

Add this table:

```markdown
# VehicleModel Contract Consumer Register

| Consumer | Owner | Surface | Current vehicleModel usage | Replacement | Target date | Sign-off |
| --- | --- | --- | --- | --- | --- | --- |
| Admin product API | Product owner | API | deprecated request/response compatibility | modelDefinitionId / modelDisplayName | 2026-07-31 | pending |
| Reports API | Finance owner | API / CSV | legacy filter and legacy CSV column | modelDefinitionId / 车型显示名 | 2026-07-31 | pending |
| Residual exports | Asset owner | CSV | legacy model fields | modelDefinitionId / modelDisplayName | 2026-07-31 | pending |
```

- [ ] **Step 2: Run evidence report**

Run:

```powershell
pnpm vehicle-model:removal-readiness
```

Expected:

```text
decision is NOT_READY until externalUsageCount is zero or formally accepted for warning mode.
```

- [ ] **Step 3: Commit**

```powershell
git add docs/vehicle-model-contract-consumer-register.md docs/stage-10x-vehicle-model-schema-contract-deprecation-plan.md
git commit -m "docs: add vehicle model contract consumer register"
```

## Task 2: API Documentation Deprecation

**Files:**
- Modify: `apps/api/src/product/dto/product.dto.ts`
- Modify: `apps/api/src/report/dto/report.dto.ts`
- Modify: `apps/api/src/vehicle/dto/vehicle.dto.ts`
- Modify: `apps/api/src/vehicle-model-definition/dto/vehicle-model-definition.dto.ts`
- Test: existing DTO and API tests

- [ ] **Step 1: Mark fields as deprecated in comments/descriptions**

Use this exact wording for deprecated request fields:

```ts
/** @deprecated Compatibility only. Use modelDefinitionId. Do not use vehicleModel for new business logic. */
vehicleModel?: VehicleModel;
```

Use this wording for deprecated response-only fields if a DTO has response descriptions:

```ts
/** @deprecated Compatibility echo. Use modelDisplayName or modelDefinitionId. */
vehicleModel?: VehicleModel | string | null;
```

- [ ] **Step 2: Run targeted tests**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/product-components.spec.ts test/report.spec.ts test/vehicle-model-integration.spec.ts
```

Expected:

```text
All targeted tests pass; no API behavior changes.
```

- [ ] **Step 3: Commit**

```powershell
git add apps/api/src/product/dto/product.dto.ts apps/api/src/report/dto/report.dto.ts apps/api/src/vehicle/dto/vehicle.dto.ts apps/api/src/vehicle-model-definition/dto/vehicle-model-definition.dto.ts
git commit -m "docs: mark vehicle model contract fields deprecated"
```

## Task 3: Warning Mode Design

**Files:**
- Modify: `apps/api/src/common/vehicle-model-usage-tracker.ts`
- Test: `apps/api/test/vehicle-model-usage-tracker.spec.ts`

- [ ] **Step 1: Add warning-mode test**

```ts
it("classifies API enum filters as warning-mode contract usage", () => {
  const tracker = new VehicleModelUsageTracker();

  tracker.record({
    decisionPath: "LEGACY_ENUM",
    legacyVehicleModelCode: "ET5",
    module: "report",
    operation: "report.filter.resolve",
    riskLevel: "MEDIUM",
    usageKind: "API_ENUM_FILTER"
  });

  expect(tracker.report()).toMatchObject({
    businessDecisionUsageCount: 0,
    decision: "NOT_READY",
    externalUsageCount: 0,
    fallbackUsageCount: 0
  });
});
```

- [ ] **Step 2: Run test**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model-usage-tracker.spec.ts
```

Expected:

```text
The test passes once warning-mode API enum filter tracking is represented without marking it as a business decision.
```

- [ ] **Step 3: Commit**

```powershell
git add apps/api/src/common/vehicle-model-usage-tracker.ts apps/api/test/vehicle-model-usage-tracker.spec.ts
git commit -m "test: cover vehicle model warning mode evidence"
```

## Task 4: CSV Contract Versioning Plan

**Files:**
- Modify: `docs/reporting-metrics.md`
- Modify: `docs/stage-10x-vehicle-model-schema-contract-deprecation-plan.md`

- [ ] **Step 1: Document CSV replacement columns**

Add this rule:

```markdown
Vehicle model CSV exports must treat `车型显示名` and `车型代码` as canonical. `legacy 车型` remains compatibility-only until the VehicleModel contract removal gate reaches `externalUsageCount = 0`.
```

- [ ] **Step 2: Run docs-only validation**

Run:

```powershell
git diff --check
pnpm vehicle-model:removal-readiness
```

Expected:

```text
No whitespace errors; readiness remains NOT_READY until contract usage is removed or accepted.
```

- [ ] **Step 3: Commit**

```powershell
git add docs/reporting-metrics.md docs/stage-10x-vehicle-model-schema-contract-deprecation-plan.md
git commit -m "docs: define vehicle model CSV deprecation contract"
```

## Task 5: Release Gate Review

**Files:**
- Modify only if needed: `scripts/release-check.mjs`

- [ ] **Step 1: Confirm readiness checks remain in release-check**

Run:

```powershell
rg -n "VehicleModel removal readiness" scripts/release-check.mjs
```

Expected:

```text
VehicleModel removal readiness syntax, core syntax, and tests are present.
```

- [ ] **Step 2: Run full release check**

Run:

```powershell
pnpm release:check
```

Expected:

```text
PASS release check.
```

- [ ] **Step 3: Commit if release gate changed**

Only commit if `scripts/release-check.mjs` changed:

```powershell
git add scripts/release-check.mjs
git commit -m "chore: keep vehicle model contract evidence in release gate"
```

## Self-Review Checklist

- [ ] API contract analysis covers responses and backward compatibility.
- [ ] CSV / report dependency plan covers external consumers and migration strategy.
- [ ] Schema removal gate includes conditions, thresholds, and rollback strategy.
- [ ] Deprecation timeline includes soft deprecation, warning mode, and removal window.
- [ ] Plan does not require schema changes, migrations, enum deletion, production deploy, or data modification in Stage 10X-U.
