# VehicleModel Enum Zero-Risk Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the frozen `VehicleModel` enum only after shadow tracking, dual-read validation, contract deprecation, dry-run rehearsal, and rollback gates prove removal is safe.

**Architecture:** Keep `modelDefinitionId` as the runtime source of truth and keep legacy enum fields as compatibility-only until every business decision, report, CSV, API contract, fixture, and integration has been proven enum-free. Use expand-contract migrations later; this plan stage itself is documentation-only and performs no schema, migration, data, or production changes.

**Tech Stack:** NestJS, Prisma, PostgreSQL, Next.js, Vitest, pnpm release checks, existing `VehicleModelResolver`, `VehicleModelLegacyAdapter`, Quote / Order snapshot helpers, report exports, and script-based governance checks.

---

## File Structure

- Main architecture document: `docs/stage-10x-vehicle-model-enum-zero-risk-removal-plan.md`
- Execution plan: `docs/superpowers/plans/2026-06-30-vehicle-model-enum-zero-risk-removal.md`
- Future tracker module: `apps/api/src/common/vehicle-model-usage-tracker.ts`
- Future tracker tests: `apps/api/test/vehicle-model-usage-tracker.spec.ts`
- Future dual-read validation module: `apps/api/src/common/vehicle-model-dual-read-validator.ts`
- Future dual-read validation tests: `apps/api/test/vehicle-model-dual-read-validator.spec.ts`
- Future report validation tests: `apps/api/test/report.spec.ts`
- Future product pricing validation tests: `apps/api/test/subscription-plan.spec.ts`
- Future API docs / DTO deprecation updates: `apps/api/src/**/dto/*.ts`
- Future README / docs index updates: `README.md`

## Task 1: Shadow Usage Tracker

**Files:**
- Create: `apps/api/src/common/vehicle-model-usage-tracker.ts`
- Test: `apps/api/test/vehicle-model-usage-tracker.spec.ts`

- [ ] **Step 1: Write the failing tracker test**

```ts
import { describe, expect, it, vi } from "vitest";

import { VehicleModelUsageTracker } from "../src/common/vehicle-model-usage-tracker";

describe("VehicleModelUsageTracker", () => {
  it("classifies business decision fallback as a blocker", () => {
    const logger = { warn: vi.fn(), log: vi.fn() };
    const tracker = new VehicleModelUsageTracker(logger as never);

    tracker.track({
      aggregateId: "plan-1",
      aggregateType: "VehiclePackage",
      enumCode: "ET5",
      fallbackReason: "BUSINESS_DECISION_FALLBACK",
      modelDefinitionId: null,
      module: "product",
      operation: "MATCH",
      severity: "BLOCKER",
      timestamp: "2026-06-30T00:00:00.000Z"
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("VehicleModel enum usage"),
      expect.objectContaining({ severity: "BLOCKER", operation: "MATCH" })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model-usage-tracker.spec.ts`

Expected: fail because `vehicle-model-usage-tracker.ts` does not exist.

- [ ] **Step 3: Implement tracker**

```ts
export type VehicleModelUsageEvent = {
  aggregateId?: string | null;
  aggregateType:
    | "Vehicle"
    | "VehiclePackage"
    | "ProductPriceRule"
    | "SubscriptionQuote"
    | "SubscriptionOrder"
    | "Report"
    | "CsvExport"
    | "Portal"
    | "Seed"
    | "Script";
  enumCode?: string | null;
  fallbackReason?:
    | "MISSING_MODEL_DEFINITION_ID"
    | "MISSING_MODEL_DEFINITION_RELATION"
    | "SNAPSHOT_ENUM_ONLY"
    | "API_LEGACY_FILTER"
    | "CSV_LEGACY_COLUMN"
    | "DISPLAY_FALLBACK"
    | "BUSINESS_DECISION_FALLBACK";
  modelDefinitionId?: string | null;
  module: string;
  operation:
    | "DISPLAY"
    | "FILTER"
    | "MATCH"
    | "PRICE_RULE_LOOKUP"
    | "REPORT_QUERY"
    | "CSV_EXPORT"
    | "SNAPSHOT_RENDER"
    | "SYSTEM_DERIVED_WRITE";
  severity: "INFO" | "WARN" | "BLOCKER";
  timestamp: string;
};

type LoggerLike = {
  log(message: string, payload?: unknown): void;
  warn(message: string, payload?: unknown): void;
};

export class VehicleModelUsageTracker {
  constructor(private readonly logger: LoggerLike) {}

  track(event: VehicleModelUsageEvent) {
    const message = "VehicleModel enum usage";
    if (event.severity === "BLOCKER" || event.severity === "WARN") {
      this.logger.warn(message, event);
      return;
    }
    this.logger.log(message, event);
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model-usage-tracker.spec.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/src/common/vehicle-model-usage-tracker.ts apps/api/test/vehicle-model-usage-tracker.spec.ts
git commit -m "chore: track legacy vehicle model enum usage"
```

## Task 2: Dual-Read Validator

**Files:**
- Create: `apps/api/src/common/vehicle-model-dual-read-validator.ts`
- Test: `apps/api/test/vehicle-model-dual-read-validator.spec.ts`

- [ ] **Step 1: Write validation tests**

```ts
import { VehicleModel } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { compareVehicleModelIdentity } from "../src/common/vehicle-model-dual-read-validator";

describe("compareVehicleModelIdentity", () => {
  it("passes when modelDefinitionId and legacy mapping resolve to the same definition", () => {
    expect(
      compareVehicleModelIdentity({
        legacyDefinitionId: "model-et5",
        modelDefinitionId: "model-et5",
        vehicleModel: VehicleModel.ET5
      })
    ).toEqual({ ok: true, reason: null });
  });

  it("blocks mismatched modelDefinitionId and legacy mapping", () => {
    expect(
      compareVehicleModelIdentity({
        legacyDefinitionId: "model-es6",
        modelDefinitionId: "model-et5",
        vehicleModel: VehicleModel.ET5
      })
    ).toEqual({ ok: false, reason: "MODEL_DEFINITION_LEGACY_MISMATCH" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model-dual-read-validator.spec.ts`

Expected: fail because validator does not exist.

- [ ] **Step 3: Implement validator**

```ts
import { VehicleModel } from "@prisma/client";

export function compareVehicleModelIdentity(input: {
  legacyDefinitionId: string | null;
  modelDefinitionId: string | null;
  vehicleModel: VehicleModel | string | null;
}) {
  if (!input.modelDefinitionId && !input.legacyDefinitionId) {
    return { ok: false, reason: "MISSING_BOTH_MODEL_IDENTITIES" as const };
  }
  if (input.modelDefinitionId && input.legacyDefinitionId && input.modelDefinitionId !== input.legacyDefinitionId) {
    return { ok: false, reason: "MODEL_DEFINITION_LEGACY_MISMATCH" as const };
  }
  return { ok: true, reason: null };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/vehicle-model-dual-read-validator.spec.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/src/common/vehicle-model-dual-read-validator.ts apps/api/test/vehicle-model-dual-read-validator.spec.ts
git commit -m "chore: add vehicle model dual read validator"
```

## Task 3: Pricing Consistency Shadow Test

**Files:**
- Modify: `apps/api/test/subscription-plan.spec.ts`

- [ ] **Step 1: Add a ProductPriceRule consistency test**

```ts
it("keeps ProductPriceRule modelDefinitionId and legacy enum mapping consistent", async () => {
  const modelDefinition = makeModelDefinition({ id: "model-et5", legacyVehicleModel: VehicleModel.ET5 });
  const priceRule = makePriceRule({ modelDefinition, modelDefinitionId: modelDefinition.id, vehicleModel: VehicleModel.ET5 });
  const { prisma, service } = makeService({
    modelDefinitions: [modelDefinition],
    priceRule,
    version: { ...version, status: ProductVersionStatus.ACTIVE }
  });

  await service.createQuote(
    "application-1",
    {
      monthlyFeeAmount: 420000,
      periodMonths: 12,
      productVersionId: "version-1",
      vehicleModel: VehicleModel.ET5,
      vehiclePurchasePriceAmount: 12000000
    },
    user,
    context
  );

  expect(prisma.productPriceRule.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        modelDefinitionId: "model-et5",
        productVersionId: "version-1"
      })
    })
  );
});
```

- [ ] **Step 2: Run targeted tests**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/subscription-plan.spec.ts`

Expected: pass.

- [ ] **Step 3: Commit**

```powershell
git add apps/api/test/subscription-plan.spec.ts
git commit -m "test: assert product price rule dual read consistency"
```

## Task 4: Report Consistency Shadow Test

**Files:**
- Modify: `apps/api/test/report.spec.ts`

- [ ] **Step 1: Add report consistency coverage**

```ts
it("returns identical order report filters for modelDefinitionId and resolved legacy vehicleModel", async () => {
  const { prisma, service } = createReportHarness();
  mockOrderReport(prisma);

  await service.getOrderReport({
    endDate: "2026-06-30",
    modelDefinitionId: "model-et5",
    startDate: "2026-06-01"
  });
  const modelDefinitionWhere = prisma.subscriptionOrder.count.mock.calls.at(-1)?.[0]?.where;

  await service.getOrderReport({
    endDate: "2026-06-30",
    startDate: "2026-06-01",
    vehicleModel: VehicleModel.ET5
  });
  const legacyWhere = prisma.subscriptionOrder.count.mock.calls.at(-1)?.[0]?.where;

  expect(legacyWhere).toEqual(modelDefinitionWhere);
});
```

- [ ] **Step 2: Run targeted tests**

Run: `pnpm --filter @subscription-saas/api exec vitest run test/report.spec.ts`

Expected: pass.

- [ ] **Step 3: Commit**

```powershell
git add apps/api/test/report.spec.ts
git commit -m "test: assert report model filter dual read consistency"
```

## Task 5: Dependency Sweep Document

**Files:**
- Modify: `docs/stage-10x-vehicle-model-enum-zero-risk-removal-plan.md`
- Modify: `README.md`

- [ ] **Step 1: Update dependency inventory**

Add or update the dependency tables for:

```text
API contracts
Reports
CSV exports
External integrations
Schema blockers
Scripts and CI governance
```

- [ ] **Step 2: Run docs and release validation**

Run: `pnpm release:check`

Expected: pass.

- [ ] **Step 3: Commit**

```powershell
git add docs/stage-10x-vehicle-model-enum-zero-risk-removal-plan.md README.md
git commit -m "docs: add vehicle model enum zero-risk removal plan"
```

## Self-Review Checklist

- [ ] Shadow usage tracking covers enum usage logger, fallback detection, and business decision detection.
- [ ] Dual-read validation covers modelDefinitionId vs enum comparison, pricing consistency, and report consistency.
- [ ] Dependency sweep covers API contracts, reports, CSV, and external integrations.
- [ ] Safety gate covers safe-removal conditions, risk thresholds, and rollback.
- [ ] Staged removal covers deprecation, soft removal, hard removal.
- [ ] Plan does not ask for schema changes, migration execution, production deploy, data rewrite, or enum deletion in the current architecture-only stage.
