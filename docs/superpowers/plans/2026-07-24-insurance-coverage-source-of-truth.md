# Insurance Coverage Source Of Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `VehicleInsurancePolicy` the only insurance-period source, require both compulsory and commercial coverage for delivery, expose accurate policy data in Admin, and safely retire the legacy vehicle insurance date columns.

**Architecture:** Add a pure policy-coverage resolver and reuse it from order readiness and vehicle serialization. Expand the policy status enum first, migrate API and UI reads to structured policy summaries, then contract the schema with a guarded migration that drops the two legacy date columns. Keep `VehicleModel` compatibility untouched.

**Tech Stack:** TypeScript 6, NestJS 11, Prisma 7/PostgreSQL, Next.js 16, React 19, Ant Design 6, Vitest 4, pnpm.

## Global Constraints

- `VehicleInsurancePolicy` is the only canonical source for insurance periods.
- Delivery requires both `COMPULSORY_TRAFFIC` and `COMMERCIAL` policies covering the evaluation date.
- Only non-deleted `ACTIVE` policies satisfy coverage; `OTHER` and `NOT_EFFECTIVE` never satisfy a required type.
- Keep `VehicleDelivery.insuranceValidConfirmed` as an independent manual verification fact.
- Policy list displays VIN and plate number; vehicle selectors support fuzzy VIN search.
- Add `VehicleInsurancePolicyStatus.NOT_EFFECTIVE`, displayed as `未生效`.
- Do not add dependencies or modify `package.json` / `pnpm-lock.yaml`.
- Do not change `VehicleModel`, quote pricing, signing, PDF, Fadada, delivery confirmation, lease, billing, or payment behavior.
- Do not query or mutate production data.
- Use explicit `git add -- <files>` paths for each commit.

---

### Task 1: Add The NOT_EFFECTIVE Policy Status

**Files:**
- Create: `apps/api/test/vehicle-insurance-schema.spec.ts`
- Create: `apps/api/prisma/migrations/20260724143000_vehicle_insurance_not_effective_status/migration.sql`
- Modify: `apps/api/prisma/schema.prisma:685-693`
- Modify: `apps/web/src/constants/labels.ts:311-317`
- Test: `apps/api/test/vehicle-insurance-schema.spec.ts`

**Interfaces:**
- Produces: Prisma enum member `VehicleInsurancePolicyStatus.NOT_EFFECTIVE`.
- Produces: UI label `VEHICLE_INSURANCE_POLICY_STATUS_LABELS.NOT_EFFECTIVE = "未生效"`.
- Consumed by: Tasks 2, 3, and 6.

- [ ] **Step 1: Write the failing schema and label test**

```ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("vehicle insurance policy status schema", () => {
  it("defines and migrates the NOT_EFFECTIVE policy status", () => {
    const schema = fs.readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");
    const migrationPath = path.resolve(
      __dirname,
      "../prisma/migrations/20260724143000_vehicle_insurance_not_effective_status/migration.sql"
    );
    const migration = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, "utf8") : "";

    expect(schema).toMatch(/enum VehicleInsurancePolicyStatus[\s\S]*NOT_EFFECTIVE/);
    expect(migration).not.toBe("");
    expect(migration).toContain(
      "ALTER TYPE \"vehicle_insurance_policy_status\" ADD VALUE IF NOT EXISTS 'NOT_EFFECTIVE'"
    );
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-insurance-schema.spec.ts
```

Expected: FAIL because the migration file and enum value do not exist.

- [ ] **Step 3: Add the enum value, migration, and label**

Add to Prisma:

```prisma
enum VehicleInsurancePolicyStatus {
  NOT_EFFECTIVE
  ACTIVE
  EXPIRED
  CANCELLED
  PENDING_RENEWAL
  ARCHIVED

  @@map("vehicle_insurance_policy_status")
}
```

Migration:

```sql
ALTER TYPE "vehicle_insurance_policy_status"
ADD VALUE IF NOT EXISTS 'NOT_EFFECTIVE';
```

Label:

```ts
export const VEHICLE_INSURANCE_POLICY_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "生效中",
  ARCHIVED: "已归档",
  CANCELLED: "已取消",
  EXPIRED: "已过期",
  NOT_EFFECTIVE: "未生效",
  PENDING_RENEWAL: "待续保"
};
```

- [ ] **Step 4: Generate Prisma Client and verify GREEN**

Run:

```bash
pnpm --filter @subscription-saas/api prisma:generate
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-insurance-schema.spec.ts
```

Expected: Prisma generation succeeds and the test passes.

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260724143000_vehicle_insurance_not_effective_status/migration.sql apps/api/test/vehicle-insurance-schema.spec.ts apps/web/src/constants/labels.ts
git commit -m "feat(insurance): add not-effective policy status"
```

---

### Task 2: Implement The Pure Dual-Policy Coverage Resolver

**Files:**
- Create: `apps/api/src/common/vehicle-insurance-coverage.ts`
- Create: `apps/api/test/vehicle-insurance-coverage.spec.ts`

**Interfaces:**
- Produces:

```ts
export interface InsurancePolicyCoverageInput {
  deletedAt?: Date | null;
  effectiveFrom: Date;
  effectiveTo: Date;
  id: string;
  policyStatus: VehicleInsurancePolicyStatus;
  policyType: VehicleInsurancePolicyType;
}

export interface VehicleInsuranceCoverageResult {
  commercial: PolicyTypeCoverage;
  compulsoryTraffic: PolicyTypeCoverage;
  covered: boolean;
  evaluationDate: Date;
}

export function resolveVehicleInsuranceCoverage(
  policies: readonly InsurancePolicyCoverageInput[],
  evaluationDate: Date
): VehicleInsuranceCoverageResult;
```

- Consumed by: Tasks 3 and 4.

- [ ] **Step 1: Write failing resolver tests**

Test these concrete cases:

```ts
it("requires both compulsory and commercial active coverage", () => {
  const result = resolveVehicleInsuranceCoverage(
    [
      policy("compulsory", VehicleInsurancePolicyType.COMPULSORY_TRAFFIC),
      policy("commercial", VehicleInsurancePolicyType.COMMERCIAL)
    ],
    new Date("2026-07-24T12:00:00.000Z")
  );

  expect(result.covered).toBe(true);
  expect(result.compulsoryTraffic.covered).toBe(true);
  expect(result.commercial.covered).toBe(true);
});

it.each([
  VehicleInsurancePolicyStatus.NOT_EFFECTIVE,
  VehicleInsurancePolicyStatus.EXPIRED,
  VehicleInsurancePolicyStatus.CANCELLED,
  VehicleInsurancePolicyStatus.PENDING_RENEWAL,
  VehicleInsurancePolicyStatus.ARCHIVED
])("does not count %s policies", (policyStatus) => {
  const result = resolveVehicleInsuranceCoverage(
    [
      policy("compulsory", VehicleInsurancePolicyType.COMPULSORY_TRAFFIC, { policyStatus }),
      policy("commercial", VehicleInsurancePolicyType.COMMERCIAL)
    ],
    new Date("2026-07-24T00:00:00.000Z")
  );

  expect(result.covered).toBe(false);
  expect(result.compulsoryTraffic.covered).toBe(false);
});
```

Also test compulsory-only, commercial-only, `OTHER`-only, deleted, expired
date range, future date range, inclusive endpoints, and deterministic selection
using latest `effectiveFrom`, latest `effectiveTo`, then id.

- [ ] **Step 2: Run the resolver tests and verify RED**

Run:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-insurance-coverage.spec.ts
```

Expected initially: module-not-found. Add only the exported interfaces and a
`resolveVehicleInsuranceCoverage()` stub that throws
`new Error("vehicle insurance coverage resolver is not implemented")`, rerun the
same command, and verify the tests now fail on that intentional error. This is
the valid RED state before implementing coverage behavior.

- [ ] **Step 3: Implement the minimal resolver**

Use UTC date keys and one deterministic selector:

```ts
const REQUIRED_TYPES = [
  VehicleInsurancePolicyType.COMPULSORY_TRAFFIC,
  VehicleInsurancePolicyType.COMMERCIAL
] as const;

export function resolveVehicleInsuranceCoverage(
  policies: readonly InsurancePolicyCoverageInput[],
  evaluationDate: Date
): VehicleInsuranceCoverageResult {
  const candidates = policies.filter(
    (policy) =>
      !policy.deletedAt &&
      policy.policyStatus === VehicleInsurancePolicyStatus.ACTIVE &&
      dateKey(policy.effectiveFrom) <= dateKey(evaluationDate) &&
      dateKey(evaluationDate) <= dateKey(policy.effectiveTo)
  );
  const compulsoryTraffic = selectCoverage(candidates, VehicleInsurancePolicyType.COMPULSORY_TRAFFIC);
  const commercial = selectCoverage(candidates, VehicleInsurancePolicyType.COMMERCIAL);

  return {
    commercial,
    compulsoryTraffic,
    covered: compulsoryTraffic.covered && commercial.covered,
    evaluationDate
  };
}
```

`selectCoverage` returns null dates/id when no candidate and sorts a copied
array so the caller input is not mutated.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-insurance-coverage.spec.ts
```

Expected: all resolver cases pass.

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/common/vehicle-insurance-coverage.ts apps/api/test/vehicle-insurance-coverage.spec.ts
git commit -m "feat(insurance): resolve required policy coverage"
```

---

### Task 3: Enforce Dual Coverage In Delivery Readiness

**Files:**
- Modify: `apps/api/src/order/order.service.ts:228-233,3840-3986,4145-4173`
- Modify: `apps/api/test/order-delivery.spec.ts:150-226,430-750`
- Test: `apps/api/test/order-delivery.spec.ts`

**Interfaces:**
- Consumes: `resolveVehicleInsuranceCoverage()` from Task 2.
- Produces:

```ts
insuranceCoverage: {
  commercialCovered: boolean;
  compulsoryTrafficCovered: boolean;
  evaluatedAt: Date;
};
```

- Consumed by: Task 6 Admin delivery UI.

- [ ] **Step 1: Replace legacy fallback tests with failing dual-policy tests**

Add tests that:

```ts
expect(check.insuranceValid).toBe(false);
expect(check.insuranceCoverage).toMatchObject({
  commercialCovered: false,
  compulsoryTrafficCovered: true
});
expect(check.blockingReasons).toContain("商业险未覆盖计划交付日");
```

Add the inverse case for missing compulsory insurance, a two-policy passing case,
and a `NOT_EFFECTIVE` case. Remove the test asserting one active policy is
sufficient and remove harness reliance on `insuranceStartDate` /
`insuranceEndDate`.

- [ ] **Step 2: Run the delivery tests and verify RED**

Run:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/order-delivery.spec.ts
```

Expected: FAIL because one active policy still passes and the response lacks
`insuranceCoverage`.

- [ ] **Step 3: Integrate the resolver and specific blockers**

Replace `isVehicleInsuranceValid()` with:

```ts
const insuranceCoverage = resolveVehicleInsuranceCoverage(
  vehicle?.insurancePolicies ?? [],
  deliveryCheckAt
);
const insuranceValid = Boolean(vehicle && insuranceCoverage.covered);
```

Return:

```ts
insuranceCoverage: {
  commercialCovered: insuranceCoverage.commercial.covered,
  compulsoryTrafficCovered: insuranceCoverage.compulsoryTraffic.covered,
  evaluatedAt: insuranceCoverage.evaluationDate
}
```

Build blockers independently:

```ts
if (!insuranceCoverage.compulsoryTraffic.covered) {
  prepareBlockingReasons.push("交强险未覆盖计划交付日");
}
if (!insuranceCoverage.commercial.covered) {
  prepareBlockingReasons.push("商业险未覆盖计划交付日");
}
```

Delete the legacy date fallback helper.

- [ ] **Step 4: Run delivery and eSign-adjacent order tests**

Run:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/order-delivery.spec.ts
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/order/order.service.ts apps/api/test/order-delivery.spec.ts
git commit -m "fix(delivery): require compulsory and commercial insurance"
```

---

### Task 4: Add Vehicle Insurance Summaries And Policy Vehicle Identity

**Files:**
- Modify: `apps/api/src/vehicle/vehicle.service.ts:38-63,114-151,1171-1210`
- Modify: `apps/api/src/vehicle-insurance/vehicle-insurance.service.ts:44-73,768-797,941-955`
- Modify: `apps/api/test/vehicle-sale-price.spec.ts:560-620`
- Modify: `apps/api/test/vehicle-insurance.spec.ts:12-76,122-251`
- Test: `apps/api/test/vehicle-sale-price.spec.ts`
- Test: `apps/api/test/vehicle-insurance.spec.ts`

**Interfaces:**
- Consumes: `resolveVehicleInsuranceCoverage()` from Task 2.
- Produces vehicle list/detail field:

```ts
insuranceCoverage: {
  commercial: { covered: boolean; effectiveFrom: string | null; effectiveTo: string | null };
  compulsoryTraffic: { covered: boolean; effectiveFrom: string | null; effectiveTo: string | null };
  covered: boolean;
  evaluatedAt: string;
}
```

- Produces policy vehicle summary `vin: string | null`.
- Consumed by: Tasks 5 and 6.

- [ ] **Step 1: Write failing vehicle serialization tests**

In `vehicle-sale-price.spec.ts`, provide one active compulsory and one active
commercial policy and assert:

```ts
expect(result[0].insuranceCoverage).toMatchObject({
  covered: true,
  compulsoryTraffic: {
    covered: true,
    effectiveFrom: "2026-07-01",
    effectiveTo: "2027-06-30"
  },
  commercial: {
    covered: true,
    effectiveFrom: "2026-07-01",
    effectiveTo: "2027-06-30"
  }
});
```

In `vehicle-insurance.spec.ts`, assert a listed policy returns:

```ts
expect(result.items[0].vehicle).toMatchObject({
  plateNo: "沪A12345",
  vehicleNo: "VH001",
  vin: "SYNTHETICVIN000001"
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-sale-price.spec.ts test/vehicle-insurance.spec.ts
```

Expected: FAIL because the vehicle insurance summary and policy vehicle VIN are
absent.

- [ ] **Step 3: Include coverage policy fields and serialize summaries**

Extend `vehicleInclude` with a selected non-deleted policy relation:

```ts
insurancePolicies: {
  select: {
    deletedAt: true,
    effectiveFrom: true,
    effectiveTo: true,
    id: true,
    policyStatus: true,
    policyType: true
  },
  where: { deletedAt: null }
}
```

Resolve at `todayDateOnly()` and serialize date-only strings. Add `vin: true` to
`policyInclude.vehicle.select`, add `vin` to `toVehicleBrief`, and return it.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-sale-price.spec.ts test/vehicle-insurance.spec.ts
```

Expected: both test files pass.

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/vehicle/vehicle.service.ts apps/api/src/vehicle-insurance/vehicle-insurance.service.ts apps/api/test/vehicle-sale-price.spec.ts apps/api/test/vehicle-insurance.spec.ts
git commit -m "feat(insurance): expose vehicle policy coverage summaries"
```

---

### Task 5: Improve Policy Management List And Vehicle Search

**Files:**
- Create: `apps/web/test/vehicle-insurance-policies-ui.spec.ts`
- Modify: `apps/web/src/app/vehicle-insurance-policies/page.tsx:53-90,168-204,353-432,515-529`
- Test: `apps/web/test/vehicle-insurance-policies-ui.spec.ts`

**Interfaces:**
- Consumes: policy `vehicle.vin`, `vehicle.plateNo`, and the
  `NOT_EFFECTIVE` label from Tasks 1 and 4.
- Produces: searchable option labels and dedicated VIN/plate table columns.

- [ ] **Step 1: Write a failing source-level UI contract test**

Read the page source and assert:

```ts
expect(source).toContain("vin?: string | null");
expect(source).toContain('optionFilterProp="label"');
expect(source).toContain('dataIndex: ["vehicle", "vin"]');
expect(source).toContain('dataIndex: ["vehicle", "plateNo"]');
expect(source).toContain('NOT_EFFECTIVE: "blue"');
```

Also assert the vehicle option label includes `vehicle.vin`.

- [ ] **Step 2: Run the UI test and verify RED**

Run:

```bash
pnpm --filter @subscription-saas/web exec vitest run test/vehicle-insurance-policies-ui.spec.ts
```

Expected: FAIL because VIN and the explicit search property are absent.

- [ ] **Step 3: Implement the policy list and selectors**

Add `vin` to `VehicleBrief` and row vehicle types. Build labels from:

```ts
[
  vehicle.vehicleNo,
  vehicle.vin,
  vehicle.plateNo,
  vehicle.brand,
  vehicle.series,
  vehicle.model
]
  .filter(Boolean)
  .join(" / ");
```

Set `optionFilterProp="label"` on both filter and create selectors. Add dedicated
columns:

```ts
{ dataIndex: ["vehicle", "vin"], render: safeValue, title: "VIN", width: 190 },
{ dataIndex: ["vehicle", "plateNo"], render: safeValue, title: "车牌号", width: 120 }
```

Add:

```ts
NOT_EFFECTIVE: "blue"
```

to `statusColors`.

- [ ] **Step 4: Run UI test, typecheck, and lint**

Run:

```bash
pnpm --filter @subscription-saas/web exec vitest run test/vehicle-insurance-policies-ui.spec.ts
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web lint
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add -- apps/web/src/app/vehicle-insurance-policies/page.tsx apps/web/test/vehicle-insurance-policies-ui.spec.ts
git commit -m "feat(admin): show vehicle identity in policy management"
```

---

### Task 6: Update Asset Ledger And Delivery Insurance UX

**Files:**
- Create: `apps/web/test/vehicle-insurance-coverage-ui.spec.ts`
- Modify: `apps/web/src/app/vehicles/page.tsx:110-150,790-806,2435-2460,6057-6078`
- Modify: `apps/web/src/app/orders/[id]/page.tsx:175-215,2919-2932,2957-2970,3040-3062`
- Test: `apps/web/test/vehicle-insurance-coverage-ui.spec.ts`

**Interfaces:**
- Consumes: vehicle `insuranceCoverage` from Task 4.
- Consumes: delivery `insuranceCoverage` from Task 3.
- Produces: separate compulsory/commercial period display and distinct manual
  verification guidance.

- [ ] **Step 1: Write failing UI contract tests**

Assert source contains:

```ts
expect(vehicleSource).toContain("交强险");
expect(vehicleSource).toContain("商业险");
expect(vehicleSource).toContain("insuranceCoverage.compulsoryTraffic");
expect(vehicleSource).toContain("insuranceCoverage.commercial");
expect(orderSource).toContain("交强险期限覆盖");
expect(orderSource).toContain("商业险期限覆盖");
expect(orderSource).toContain("保险人工核验");
```

Assert the manual guidance branch occurs before the general policy-management
link branch.

- [ ] **Step 2: Run the UI test and verify RED**

Run:

```bash
pnpm --filter @subscription-saas/web exec vitest run test/vehicle-insurance-coverage-ui.spec.ts
```

Expected: FAIL because the pages still use the shared legacy period and ambiguous
copy.

- [ ] **Step 3: Implement asset and delivery presentation**

Replace `formatInsurancePeriod(vehicle)` with a formatter accepting one structured
policy-type coverage. Render two compact lines in the asset list and two
descriptions in detail.

Extend `DeliveryCheck` with:

```ts
insuranceCoverage: {
  commercialCovered: boolean;
  compulsoryTrafficCovered: boolean;
  evaluatedAt: string;
};
```

Show separate boolean tags. Rename checklist copy to `保险人工核验`. In blocker
guidance:

```tsx
if (reason.includes("保险人工核验")) {
  return <Typography.Text type="secondary">请在准备交付弹窗中确认</Typography.Text>;
}
if (reason.includes("交强险") || reason.includes("商业险")) {
  return <Link href="/vehicle-insurance-policies">去保单管理</Link>;
}
```

- [ ] **Step 4: Run UI tests, typecheck, lint, and build**

Run:

```bash
pnpm --filter @subscription-saas/web exec vitest run test/vehicle-insurance-coverage-ui.spec.ts test/vehicle-insurance-policies-ui.spec.ts
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web build
```

Expected: all commands exit 0 and the build lists `/vehicles`,
`/vehicle-insurance-policies`, and `/orders/[id]`.

- [ ] **Step 5: Commit**

```bash
git add -- apps/web/src/app/vehicles/page.tsx apps/web/src/app/orders/[id]/page.tsx apps/web/test/vehicle-insurance-coverage-ui.spec.ts
git commit -m "fix(admin): clarify insurance coverage and verification"
```

---

### Task 7: Retire Legacy Vehicle Insurance Date Columns

**Files:**
- Create: `apps/api/prisma/migrations/20260724150000_vehicle_insurance_policy_source_of_truth/migration.sql`
- Modify: `apps/api/prisma/schema.prisma:2779-2806`
- Modify: `apps/api/src/vehicle/dto/vehicle.dto.ts:65-90,155-185`
- Modify: `apps/api/src/vehicle/vehicle.service.ts:870-940,1171-1210`
- Modify: `apps/web/src/app/vehicles/page.tsx:110-150`
- Modify: `apps/api/test/application-review-api.spec.ts`
- Modify: `apps/api/test/capital-structure.spec.ts`
- Modify: `apps/api/test/customer-order.spec.ts`
- Modify: `apps/api/test/order-delivery.spec.ts`
- Modify: `apps/api/test/portal-application.spec.ts`
- Modify: `apps/api/test/portal-catalog.spec.ts`
- Modify: `apps/api/test/residual-market.spec.ts`
- Modify: `apps/api/test/revenue-right.spec.ts`
- Modify: `apps/api/test/seed-delivery-handover.spec.ts`
- Modify: `apps/api/test/self-service-application.spec.ts`
- Modify: `apps/api/test/subscription-plan.spec.ts`
- Modify: `apps/api/test/vehicle-model-integration.spec.ts`
- Modify: `apps/api/test/vehicle-sale-price.spec.ts`
- Modify: `apps/api/test/vehicle-valuation-review.spec.ts`

- Modify: `docs/stage2-delivery-handover-signing.md:150-160`
- Modify: `docs/stage-10m-b-vehicle-insurance-documents-claims.md`
- Test: `apps/api/test/vehicle-insurance-schema.spec.ts`

**Interfaces:**
- Removes: `Vehicle.insuranceStartDate` and `Vehicle.insuranceEndDate`.
- Preserves: policy relations, structured summaries, delivery coverage, and
  manual checklist fields.

- [ ] **Step 1: Extend the schema test and verify RED**

Add:

```ts
expect(schema).not.toContain("insuranceStartDate");
expect(schema).not.toContain("insuranceEndDate");
expect(dropMigration).toContain('DROP COLUMN "insurance_start_date"');
expect(dropMigration).toContain('DROP COLUMN "insurance_end_date"');
expect(dropMigration).toContain("RAISE EXCEPTION");
```

Run:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-insurance-schema.spec.ts
```

Expected: FAIL because the fields and drop migration still do not exist.

- [ ] **Step 2: Add the guarded drop migration**

Use a pre-drop guard:

```sql
DO $$
DECLARE
  incomplete_vehicle_count INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO incomplete_vehicle_count
  FROM "vehicle" v
  WHERE
    (v."insurance_start_date" IS NOT NULL OR v."insurance_end_date" IS NOT NULL)
    AND (
      NOT EXISTS (
        SELECT 1
        FROM "vehicle_insurance_policy" p
        WHERE p."vehicle_id" = v."id"
          AND p."deleted_at" IS NULL
          AND p."policy_status" = 'ACTIVE'
          AND p."policy_type" = 'COMPULSORY_TRAFFIC'
      )
      OR NOT EXISTS (
        SELECT 1
        FROM "vehicle_insurance_policy" p
        WHERE p."vehicle_id" = v."id"
          AND p."deleted_at" IS NULL
          AND p."policy_status" = 'ACTIVE'
          AND p."policy_type" = 'COMMERCIAL'
      )
    );

  IF incomplete_vehicle_count > 0 THEN
    RAISE EXCEPTION
      'vehicle insurance source-of-truth migration blocked: % vehicles have legacy dates without both active required policy types',
      incomplete_vehicle_count;
  END IF;
END $$;

ALTER TABLE "vehicle"
  DROP COLUMN "insurance_start_date",
  DROP COLUMN "insurance_end_date";
```

- [ ] **Step 3: Remove schema, DTO, serializer, UI type, and fixture references**

Delete both Prisma fields, both create/update DTO fields, create/update service
assignments, legacy response fields, and every test fixture property. Update docs
to state that both required policy types are canonical and no fallback remains.

Run the repository guard:

```bash
rg -n "insuranceStartDate|insuranceEndDate" apps/api/src apps/web/src apps/api/test packages/shared/src scripts
```

Expected: no matches.

- [ ] **Step 4: Generate, validate, and run focused tests**

Run:

```bash
pnpm --filter @subscription-saas/api prisma:validate
pnpm --filter @subscription-saas/api prisma:generate
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-insurance-schema.spec.ts test/vehicle-insurance-coverage.spec.ts test/vehicle-insurance.spec.ts test/order-delivery.spec.ts test/vehicle-sale-price.spec.ts
```

Expected: Prisma validation/generation succeeds and all selected tests pass.

- [ ] **Step 5: Commit**

Stage the approved paths explicitly:

```bash
git add -- apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260724150000_vehicle_insurance_policy_source_of_truth/migration.sql apps/api/src/vehicle/dto/vehicle.dto.ts apps/api/src/vehicle/vehicle.service.ts apps/web/src/app/vehicles/page.tsx apps/api/test/application-review-api.spec.ts apps/api/test/capital-structure.spec.ts apps/api/test/customer-order.spec.ts apps/api/test/order-delivery.spec.ts apps/api/test/portal-application.spec.ts apps/api/test/portal-catalog.spec.ts apps/api/test/residual-market.spec.ts apps/api/test/revenue-right.spec.ts apps/api/test/seed-delivery-handover.spec.ts apps/api/test/self-service-application.spec.ts apps/api/test/subscription-plan.spec.ts apps/api/test/vehicle-model-integration.spec.ts apps/api/test/vehicle-sale-price.spec.ts apps/api/test/vehicle-valuation-review.spec.ts docs/stage2-delivery-handover-signing.md docs/stage-10m-b-vehicle-insurance-documents-claims.md
git commit -m "refactor(insurance): remove legacy vehicle coverage dates"
```

---

### Task 8: Full Verification And Safety Review

**Files:**
- Modify only files required to fix verification failures caused by Tasks 1-7.
- Test: all relevant API/Web checks.

**Interfaces:**
- Consumes all earlier task outputs.
- Produces a verified, locally committed branch ready for user-selected publish
  handling.

- [ ] **Step 1: Run complete API verification**

```bash
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/api build
```

Expected: all commands exit 0.

- [ ] **Step 2: Run complete Web verification**

```bash
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web test
pnpm --filter @subscription-saas/web build
```

Expected: all commands exit 0.

- [ ] **Step 3: Run schema and repository guards**

```bash
pnpm --filter @subscription-saas/api prisma:validate
pnpm --filter @subscription-saas/api prisma:generate
rg -n "insuranceStartDate|insuranceEndDate" apps/api/src apps/web/src apps/api/test packages/shared/src scripts
git diff origin/main...HEAD -- apps/api/prisma/schema.prisma apps/api/prisma/migrations
git diff --check
```

Expected:

- Prisma commands exit 0;
- legacy field search returns no matches;
- migration diff contains only the approved insurance enum addition and guarded
  legacy column removal;
- `git diff --check` returns no output.

- [ ] **Step 4: Confirm forbidden scope remains unchanged**

```bash
git diff --name-only origin/main...HEAD
git diff origin/main...HEAD -- apps/api/src/esign apps/api/src/lease apps/api/src/billing apps/api/src/finance Dockerfile.api docker-compose.prod.example.yml package.json pnpm-lock.yaml
```

Expected: no unapproved signing, lease, billing, finance, Docker, compose,
package, or lockfile changes.

- [ ] **Step 5: Commit verification-only fixes when present**

If verification required source changes, stage each changed file explicitly and
commit:

```bash
git commit -m "test(insurance): complete coverage regression checks"
```

If no fixes are required, do not create an empty commit.

- [ ] **Step 6: Record final branch state**

```bash
git status --short --branch --untracked-files=all
git log --oneline --decorate origin/main..HEAD
```

Expected: clean worktree on `fix/insurance-coverage-source-of-truth`.
