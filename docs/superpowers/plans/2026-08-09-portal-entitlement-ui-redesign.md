# Portal Entitlement UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Rebuild the Portal entitlement page around type tabs and option-B balance cards so customers can read current availability, period order, status and type-filtered usage history without changing entitlement business contracts.

**Architecture:** Keep the existing Portal entitlement and usage APIs unchanged. Add pure view-model functions for Shanghai-date period classification, stable sorting, default-tab selection and progress; add a reusable paged loader that exhausts existing paged responses; render the result through a type-tab overview with responsive cards and the existing usage-record projections.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 6, Ant Design 6, CSS Modules, Vitest 4, existing portalApiFetch and Portal DTO types.

## Global Constraints

- Work only in "D:/Projects/auto-subscription-platform/.worktrees/portal-entitlement-ui-20260809" on "fix/portal-entitlement-ui-20260809".
- Execute inline in the main agent; do not dispatch subagents.
- Approved design: "docs/superpowers/specs/2026-08-09-portal-entitlement-ui-redesign-design.zh-CN.md".
- Scope is limited to the Portal entitlement page UI and client-side data projection.
- Do not modify database schema, migrations, seeds, entitlement calculations, API controllers, API services or API DTOs.
- Do not change attachment upload, filename repair or deployment behavior. Upload was separately re-accepted on "Staging-20260809-9d12f7e".
- Fixed type order: BENEFIT, ENERGY, MILEAGE.
- Period order: current, future nearest-first, historical nearest-first, evaluated with the Asia/Shanghai business date.
- EXPIRED and CANCELLED cards are gray; EXHAUSTED remains readable with 100% progress and zero available.
- Display totalAmount, usedAmount and remainingAmount from the API; never recompute the ledger balance.
- TEXT cards show 已发放 / 不适用 / 可使用或不可用 and no progress bar.
- Use TDD for every production change: write the focused test, observe the expected failure, then add the minimal implementation.
- Preserve the 768px breakpoint and verify 360px, 390px, 768px and desktop widths.

---

## File Structure

```text
apps/web/src/app/portal/entitlements/
  entitlement-view-model.ts          Pure period, sorting, grouping, default-tab and progress rules
  entitlement-overview.tsx           Fixed type tabs, option-B cards and filtered usage section
  entitlement-overview.module.css    Responsive card grid, metrics and status presentation
  entitlement-records.tsx            Existing usage desktop table/mobile cards only
  entitlement-records.module.css     Existing usage record responsive styles
  entitlement-page-content.tsx       Loading, error/retry and complete-data presentation states
  portal-paged-loader.ts             Exhausts existing PortalPagedResponse endpoints
  page.tsx                            Authentication-aware load/retry container and page shell

apps/web/test/
  portal-entitlement-view-model.spec.ts
  portal-entitlement-overview.spec.tsx
  portal-entitlement-page-content.spec.tsx
  portal-entitlement-records.spec.tsx
  portal-paged-loader.spec.ts

docs/
  portal-entitlement-ui-acceptance.zh-CN.md
```

The pure view model owns business-date projection. The paged loader owns URL paging and completeness. The overview owns presentation state only. The page remains the sole network and authentication container.

---

### Task 1: Entitlement Period and Card View Model

**Files:**

- Create: "apps/web/src/app/portal/entitlements/entitlement-view-model.ts"
- Create: "apps/web/test/portal-entitlement-view-model.spec.ts"

**Interfaces:**

- Consumes: PortalEntitlementGrant from "apps/web/src/lib/portal-types.ts".
- Produces:

```ts
export const PORTAL_ENTITLEMENT_TYPES = ["BENEFIT", "ENERGY", "MILEAGE"] as const;
export type PortalEntitlementType = (typeof PORTAL_ENTITLEMENT_TYPES)[number];
export type EntitlementPeriodBucket = "CURRENT" | "FUTURE" | "HISTORICAL";

export function shanghaiBusinessDateKey(now?: Date): string;
export function entitlementPeriodBucket(
  grant: PortalEntitlementGrant,
  todayKey: string
): EntitlementPeriodBucket;
export function sortEntitlementGrants(
  rows: PortalEntitlementGrant[],
  todayKey: string
): PortalEntitlementGrant[];
export function groupEntitlementGrants(
  rows: PortalEntitlementGrant[],
  todayKey: string
): Record<PortalEntitlementType, PortalEntitlementGrant[]>;
export function selectDefaultEntitlementType(
  groups: Record<PortalEntitlementType, PortalEntitlementGrant[]>,
  todayKey: string
): PortalEntitlementType;
export function entitlementProgress(grant: PortalEntitlementGrant): number | null;
export function isUnavailableEntitlement(grant: PortalEntitlementGrant): boolean;
export function isTextEntitlement(grant: PortalEntitlementGrant): boolean;
```

- Missing validFrom is treated as historical and sorted after dated historical records. The API normally supplies it, but the Web type remains nullable.

- [ ] **Step 1: Write failing business-date and period tests**

Create the test with a complete local grantFixture and these assertions:

```ts
expect(shanghaiBusinessDateKey(new Date("2026-08-08T16:30:00.000Z"))).toBe("2026-08-09");

expect(
  entitlementPeriodBucket(
    grantFixture({ validFrom: "2026-08-01", validTo: "2026-08-31" }),
    "2026-08-09"
  )
).toBe("CURRENT");
expect(
  entitlementPeriodBucket(
    grantFixture({ validFrom: "2026-08-10", validTo: "2026-09-09" }),
    "2026-08-09"
  )
).toBe("FUTURE");
expect(
  entitlementPeriodBucket(
    grantFixture({ validFrom: "2026-07-01", validTo: "2026-07-31" }),
    "2026-08-09"
  )
).toBe("HISTORICAL");
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/portal-entitlement-view-model.spec.ts
```

Expected: FAIL because the view-model module does not exist.

- [ ] **Step 3: Implement Shanghai date and period classification**

Use Intl.DateTimeFormat with timeZone "Asia/Shanghai" and formatToParts, then explicitly compose YYYY-MM-DD.

Implement:

```ts
export function entitlementPeriodBucket(
  grant: PortalEntitlementGrant,
  todayKey: string
): EntitlementPeriodBucket {
  if (!grant.validFrom) return "HISTORICAL";
  if (grant.validFrom > todayKey) return "FUTURE";
  if (grant.validTo && grant.validTo < todayKey) return "HISTORICAL";
  return "CURRENT";
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command. Expected: the date and period tests PASS.

- [ ] **Step 5: Add failing stable-sort and grouping tests**

Prove the exact order:

```ts
expect(
  sortEntitlementGrants(
    [
      grantFixture({
        grantId: "old",
        grantNo: "G-4",
        validFrom: "2026-06-01",
        validTo: "2026-06-30"
      }),
      grantFixture({
        grantId: "future-far",
        grantNo: "G-3",
        validFrom: "2026-10-01",
        validTo: "2026-10-31"
      }),
      grantFixture({
        grantId: "current",
        grantNo: "G-2",
        validFrom: "2026-08-05",
        validTo: "2026-08-31"
      }),
      grantFixture({
        grantId: "future-near",
        grantNo: "G-1",
        validFrom: "2026-09-01",
        validTo: "2026-09-30"
      }),
      grantFixture({
        grantId: "recent",
        grantNo: "G-5",
        validFrom: "2026-07-01",
        validTo: "2026-07-31"
      })
    ],
    "2026-08-09"
  ).map((row) => row.grantId)
).toEqual(["current", "future-near", "future-far", "recent", "old"]);
```

Also prove:

- fixed groups contain BENEFIT, ENERGY and MILEAGE even when empty;
- groups are sorted;
- same-date rows use grantNo ascending as the stable tie breaker;
- an unknown type does not create a fourth tab.

- [ ] **Step 6: Run and verify RED**

Run the Step 2 command. Expected: FAIL because sorting/grouping exports are missing.

- [ ] **Step 7: Implement stable grouping and sorting**

Use rank CURRENT=0, FUTURE=1, HISTORICAL=2. Compare current starts descending, future starts ascending, historical ends descending, then grantNo with localeCompare. Return new arrays and never mutate fetched rows.

- [ ] **Step 8: Run and verify GREEN**

Run the Step 2 command. Expected: sorting/grouping tests PASS.

- [ ] **Step 9: Add failing default-tab, progress and state tests**

Assert:

```ts
expect(selectDefaultEntitlementType(groupsWithCurrentEnergy, "2026-08-09")).toBe("ENERGY");
expect(selectDefaultEntitlementType(groupsWithOnlyMileageHistory, "2026-08-09")).toBe("MILEAGE");
expect(selectDefaultEntitlementType(emptyGroups, "2026-08-09")).toBe("BENEFIT");

expect(entitlementProgress(grantFixture({ totalAmount: 300, usedAmount: 80 }))).toBeCloseTo(
  26.67,
  2
);
expect(entitlementProgress(grantFixture({ totalAmount: 10, usedAmount: 20 }))).toBe(100);
expect(
  entitlementProgress(grantFixture({ status: "EXHAUSTED", totalAmount: 300, usedAmount: 80 }))
).toBe(100);
expect(entitlementProgress(grantFixture({ totalAmount: 0, usedAmount: 0 }))).toBeNull();
expect(entitlementProgress(grantFixture({ unit: "TEXT", totalAmount: null }))).toBeNull();
expect(isUnavailableEntitlement(grantFixture({ status: "EXPIRED" }))).toBe(true);
expect(isUnavailableEntitlement(grantFixture({ status: "CANCELLED" }))).toBe(true);
expect(isUnavailableEntitlement(grantFixture({ status: "EXHAUSTED" }))).toBe(false);
```

The first default test must include an earlier BENEFIT history row and a current active ENERGY row so current-active wins before fixed type order.

- [ ] **Step 10: Run and verify RED**

Run the Step 2 command. Expected: FAIL on missing selection/progress helpers.

- [ ] **Step 11: Implement selection, progress and status helpers**

Default selection:

1. scan fixed types for a CURRENT row with status ACTIVE;
2. scan fixed types for any row;
3. return BENEFIT.

Progress:

1. null for TEXT, null total or total <= 0;
2. 100 for EXHAUSTED;
3. calculate used / total \* 100;
4. clamp to 0..100.

- [ ] **Step 12: Run focused tests, typecheck and commit**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/portal-entitlement-view-model.spec.ts
pnpm --filter @subscription-saas/web typecheck
```

Expected: PASS.

Commit:

```powershell
git add apps/web/src/app/portal/entitlements/entitlement-view-model.ts apps/web/test/portal-entitlement-view-model.spec.ts
git commit -m "feat: model portal entitlement periods"
```

---

### Task 2: Fixed Type Tabs and Option-B Cards

**Files:**

- Create: "apps/web/src/app/portal/entitlements/entitlement-overview.tsx"
- Create: "apps/web/src/app/portal/entitlements/entitlement-overview.module.css"
- Create: "apps/web/test/portal-entitlement-overview.spec.tsx"
- Modify: "apps/web/src/app/portal/entitlements/entitlement-records.tsx"
- Modify: "apps/web/src/app/portal/entitlements/entitlement-records.module.css"
- Modify: "apps/web/test/portal-entitlement-records.spec.tsx"

**Interfaces:**

```ts
export interface PortalEntitlementOverviewProps {
  grants: PortalEntitlementGrant[];
  todayKey?: string;
  usages: PortalEntitlementUsage[];
}

export function PortalEntitlementOverview(props: PortalEntitlementOverviewProps): React.ReactNode;

export interface PortalEntitlementTypePanelProps {
  grants: PortalEntitlementGrant[];
  todayKey: string;
  type: PortalEntitlementType;
  usages: PortalEntitlementUsage[];
}

export function PortalEntitlementTypePanel(props: PortalEntitlementTypePanelProps): React.ReactNode;
```

- todayKey defaults to shanghaiBusinessDateKey() and is injectable for deterministic tests.
- The overview owns selected type only and performs no fetch.
- PortalEntitlementUsageRecords receives already-filtered rows.

- [ ] **Step 1: Write a failing overview render test**

Create fixtures for:

- historical BENEFIT;
- current active ENERGY;
- current EXHAUSTED ENERGY;
- EXPIRED ENERGY;
- TEXT ENERGY;
- usages from BENEFIT and ENERGY.

Render PortalEntitlementOverview with todayKey "2026-08-09". Assert:

```ts
expect(html).toContain("服务权益");
expect(html).toContain("补能权益");
expect(html).toContain("里程权益");
expect(html).toContain("当前可用");
expect(html).toContain("220 kWh");
expect(html).toContain("初始额度");
expect(html).toContain("300 kWh");
expect(html).toContain("已核销");
expect(html).toContain("80 kWh");
expect(html).toContain("补能权益核销明细");
expect(html).toContain("能源核销");
expect(html).not.toContain("洗车核销");
expect(html).toContain('data-status="EXPIRED"');
expect(html).toContain('data-status="EXHAUSTED"');
expect(html).toContain("已发放");
expect(html).toContain("不适用");
```

The current active ENERGY row makes ENERGY the default panel.

- [ ] **Step 2: Run and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/portal-entitlement-overview.spec.tsx
```

Expected: FAIL because the overview does not exist.

- [ ] **Step 3: Implement the fixed tab overview**

Use Ant Design Tabs with all three items and grouped counts. Use:

```ts
const [selectedType, setSelectedType] = useState<PortalEntitlementType | null>(null);
const defaultType = selectDefaultEntitlementType(groups, resolvedTodayKey);
const activeType = selectedType ?? defaultType;
```

Pass only groups[activeType] and usages matching activeType to PortalEntitlementTypePanel. Keep empty tabs visible.

- [ ] **Step 4: Implement the option-B card body**

Numeric card:

```tsx
<div className={styles.availableValue}>
  <span>{formatEntitlementAmount(grant.remainingAmount, grant.unit)}</span>
  <small>当前可用</small>
</div>
```

Render Ant Design Progress only when entitlementProgress is not null. Below it, show initial and used metrics. Add data-status to the article and apply unavailable styling only to EXPIRED/CANCELLED.

TEXT card:

```tsx
<span>{grant.status === "ACTIVE" ? "可使用" : "不可用"}</span>
<Metric label="初始额度" value="已发放" />
<Metric label="已核销" value="不适用" />
```

Render source, valid period and grant number as secondary content. Never calculate remaining as total minus used.

Use entitlementPeriodBucket(grant, todayKey) in the header. Show “当前期” for CURRENT; future and historical cards show their effective date range without inventing a stored cycle number.

- [ ] **Step 5: Reduce the old record component to usages**

Remove PortalEntitlementGrantRecords, grantColumns and grant-only markup from "entitlement-records.tsx". Retain PortalEntitlementUsageRecords, its desktop table, mobile cards, amount formatting and time formatting.

Update "portal-entitlement-records.spec.tsx" to render one usage row and assert:

- usage mobile card test ID;
- amount and unit;
- Chinese labels;
- long identifier wrapping;
- 768px desktop/mobile projection.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/portal-entitlement-overview.spec.tsx test/portal-entitlement-records.spec.tsx
```

Expected: PASS.

- [ ] **Step 7: Add failing status and responsive CSS contracts**

Read the overview CSS and assert:

```ts
expect(css).toMatch(/\.cardGrid\s*\{[\s\S]*grid-template-columns:\s*repeat\(2/);
expect(css).toMatch(/@media\s*\(max-width:\s*768px\)/);
expect(css).toMatch(/@media[\s\S]*\.cardGrid\s*\{[\s\S]*grid-template-columns:\s*1fr/);
expect(css).toMatch(/\.unavailableCard\s*\{[\s\S]*background/);
expect(css).toContain("overflow-wrap: anywhere");
expect(css).not.toContain("overflow-x: scroll");
```

Assert EXPIRED gets unavailableCard and EXHAUSTED does not. Assert visible text or aria semantics communicates progress without color alone.

- [ ] **Step 8: Run and verify RED**

Run the Step 6 command. Expected: FAIL until the exact responsive/status CSS exists.

- [ ] **Step 9: Implement responsive and state styling**

Requirements:

- two card columns above 768px;
- one column at or below 768px;
- no horizontal page overflow;
- gray unavailable card with sufficient contrast;
- prominent available value;
- grouped numbers and units;
- overflow-wrap only for long machine identifiers;
- min-width: 0 on grid and card children;
- retain native Ant Design focus behavior.

- [ ] **Step 10: Run tests, typecheck and commit**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/portal-entitlement-view-model.spec.ts test/portal-entitlement-overview.spec.tsx test/portal-entitlement-records.spec.tsx
pnpm --filter @subscription-saas/web typecheck
```

Expected: PASS.

Commit:

```powershell
git add apps/web/src/app/portal/entitlements/entitlement-overview.tsx apps/web/src/app/portal/entitlements/entitlement-overview.module.css apps/web/src/app/portal/entitlements/entitlement-records.tsx apps/web/src/app/portal/entitlements/entitlement-records.module.css apps/web/test/portal-entitlement-overview.spec.tsx apps/web/test/portal-entitlement-records.spec.tsx
git commit -m "feat: organize portal entitlements by type"
```

---

### Task 3: Exhaust Paged Data and Add Retry State

**Files:**

- Create: "apps/web/src/app/portal/entitlements/portal-paged-loader.ts"
- Create: "apps/web/src/app/portal/entitlements/entitlement-page-content.tsx"
- Create: "apps/web/test/portal-paged-loader.spec.ts"
- Create: "apps/web/test/portal-entitlement-page-content.spec.tsx"
- Modify: "apps/web/src/app/portal/entitlements/page.tsx"

**Interfaces:**

```ts
export type PortalPageFetcher = <T>(path: string) => Promise<PortalPagedResponse<T>>;

export function portalPagedPath(basePath: string, page: number, pageSize: number): string;

export async function fetchAllPortalPages<T>(
  basePath: string,
  fetchPage: PortalPageFetcher,
  pageSize?: number
): Promise<T[]>;

export interface PortalEntitlementPageData {
  grants: PortalEntitlementGrant[];
  usages: PortalEntitlementUsage[];
}

export async function loadPortalEntitlementPageData(
  orderId: string | null,
  fetchPage: PortalPageFetcher
): Promise<PortalEntitlementPageData>;
```

- Default page size is 100.
- Preserve orderId and other existing query parameters.
- When total is unmet but a page is empty, throw Error("PORTAL_PAGINATION_INCOMPLETE").

- [ ] **Step 1: Write failing paging URL tests**

```ts
expect(portalPagedPath("/portal/entitlements", 1, 100)).toBe(
  "/portal/entitlements?page=1&pageSize=100"
);
expect(portalPagedPath("/portal/entitlements?orderId=order-1", 2, 100)).toBe(
  "/portal/entitlements?orderId=order-1&page=2&pageSize=100"
);
```

- [ ] **Step 2: Run and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/portal-paged-loader.spec.ts
```

Expected: FAIL because the loader module does not exist.

- [ ] **Step 3: Implement deterministic paging paths**

Split at the first question mark, parse URLSearchParams, overwrite page/pageSize, and return the original relative path plus serialized query. Do not construct an absolute browser URL.

- [ ] **Step 4: Run and verify GREEN**

Run the Step 2 command. Expected: URL tests PASS.

- [ ] **Step 5: Add failing loader completeness tests**

Use a generic fake fetcher and prove:

- total 2 needs one call;
- total 102 needs page 1 with 100 rows and page 2 with 2 rows;
- orderId remains in both recorded paths;
- an empty page 2 with total 102 rejects with PORTAL_PAGINATION_INCOMPLETE;
- a page 2 fetch error propagates unchanged.

- [ ] **Step 6: Run and verify RED**

Run the Step 2 command. Expected: FAIL because fetchAllPortalPages is missing.

- [ ] **Step 7: Implement the exhaustive loader**

Always fetch page 1. Append rows until loaded length reaches total. Increment page by one. Reject before another iteration if the last page was empty while total remains unmet. Do not deduplicate or silently truncate.

- [ ] **Step 8: Run and verify GREEN**

Run the Step 2 command. Expected: loader tests PASS.

- [ ] **Step 9: Add failing complete-data and page-state behavior tests**

Extend the loader test with a real loadPortalEntitlementPageData call. Use a fake page fetcher that returns one grant page and one usage page. Assert the result contains both complete arrays and the recorded URLs preserve orderId while setting page=1 and pageSize=100.

Create "portal-entitlement-page-content.spec.tsx". Render the real presentational component in three states:

```tsx
expect(
  renderToStaticMarkup(
    <PortalEntitlementPageContent
      error={null}
      grants={[]}
      loading
      onRetry={() => undefined}
      usages={[]}
    />
  )
).toContain("正在加载权益");

expect(
  renderToStaticMarkup(
    <PortalEntitlementPageContent
      error="权益读取失败"
      grants={[]}
      loading={false}
      onRetry={() => undefined}
      usages={[]}
    />
  )
).toContain("重新加载");

expect(
  renderToStaticMarkup(
    <PortalEntitlementPageContent
      error={null}
      grants={[currentEnergyGrant]}
      loading={false}
      onRetry={() => undefined}
      usages={[]}
    />
  )
).toContain("当前可用");
```

These tests fail if loading, error/retry or complete-data rendering is removed, without inspecting source text.

- [ ] **Step 10: Run and verify RED**

Run the Step 2 command. Expected: FAIL because the complete-data loader and page-state component do not exist.

- [ ] **Step 11: Implement complete-data loading and rewire the page**

Implement loadPortalEntitlementPageData with Promise.all over:

- fetchAllPortalPages for "/portal/entitlements";
- fetchAllPortalPages for "/portal/entitlements/usages";
- the same encoded orderId query on both paths when orderId is present.

Implement PortalEntitlementPageContent as a real component that renders:

- an active Skeleton and visible “正在加载权益” text while loading;
- Alert plus “重新加载” button on error;
- PortalEntitlementOverview only in the complete-data state.

Then rewire "page.tsx":

1. import PortalEntitlementPageContent and loadPortalEntitlementPageData;
2. pass orderId to the complete-data loader;
3. add loadVersion state for retry;
4. set loading and clear error before each read;
5. load complete grants and usages through loadPortalEntitlementPageData;
6. guard state updates with an active boolean and effect cleanup;
7. retain existing 401 login redirect;
8. store other safe messages or “无法加载权益信息”;
9. retain the page heading and pass loading/error/complete arrays into PortalEntitlementPageContent;
10. pass an onRetry callback that increments loadVersion.

Remove the separate old balance and usage sections because the overview owns the combined hierarchy.

- [ ] **Step 12: Run focused tests, typecheck and commit**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/portal-paged-loader.spec.ts test/portal-entitlement-page-content.spec.tsx test/portal-entitlement-view-model.spec.ts test/portal-entitlement-overview.spec.tsx test/portal-entitlement-records.spec.tsx
pnpm --filter @subscription-saas/web typecheck
```

Expected: PASS.

Commit:

```powershell
git add apps/web/src/app/portal/entitlements/page.tsx apps/web/src/app/portal/entitlements/entitlement-page-content.tsx apps/web/src/app/portal/entitlements/portal-paged-loader.ts apps/web/test/portal-entitlement-page-content.spec.tsx apps/web/test/portal-paged-loader.spec.ts
git commit -m "feat: load complete portal entitlement history"
```

---

### Task 4: Full Verification and Acceptance Handoff

**Files:**

- Create: "docs/portal-entitlement-ui-acceptance.zh-CN.md"
- Modify only after a failing regression test: files named in Tasks 1-3.

**Interfaces:**

- Consumes all Task 1-3 outputs.
- Produces reproducible verification evidence and a staging checklist limited to the Portal entitlement page.

- [ ] **Step 1: Run formatting and focused tests**

```powershell
pnpm exec prettier --check apps/web/src/app/portal/entitlements apps/web/test/portal-entitlement-view-model.spec.ts apps/web/test/portal-entitlement-overview.spec.tsx apps/web/test/portal-entitlement-page-content.spec.tsx apps/web/test/portal-entitlement-records.spec.tsx apps/web/test/portal-paged-loader.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/portal-entitlement-view-model.spec.ts test/portal-entitlement-overview.spec.tsx test/portal-entitlement-page-content.spec.tsx test/portal-entitlement-records.spec.tsx test/portal-paged-loader.spec.ts
```

Expected: formatting and focused tests PASS. If formatting fails, format only files changed by this plan and repeat.

- [ ] **Step 2: Run Web regression gates**

```powershell
pnpm --filter @subscription-saas/web test
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web build
```

Expected: all commands exit 0 with no new branch-attributable warnings.

- [ ] **Step 3: Inspect diff and scope**

```powershell
git diff origin/main...HEAD --check
git diff origin/main...HEAD --name-only
git status --short --branch
```

Expected:

- only the approved design/plan, Portal entitlement Web files/tests and acceptance document changed;
- no API, Prisma, migration, attachment or deployment file appears;
- no unrelated untracked file exists.

- [ ] **Step 4: Perform responsive browser verification**

Using non-production data with all three types and multiple periods, check 360px, 390px, 768px and desktop:

1. fixed tabs and counts;
2. default current-active tab;
3. current/future/history order;
4. option-B available value and progress;
5. expired/cancelled gray and exhausted non-gray;
6. TEXT without a progress bar;
7. type-filtered usage records;
8. no page-level horizontal overflow;
9. readable long names and IDs;
10. retry state and clean browser console/network.

If local authenticated data is unavailable, record automated render evidence now and explicitly defer the real-account viewport checklist to staging after deployment. Do not claim an unperformed browser check.

- [ ] **Step 5: Write acceptance evidence**

Create "docs/portal-entitlement-ui-acceptance.zh-CN.md" with:

- branch and commit;
- exact commands and pass counts;
- responsive checks actually performed;
- checks deferred to staging;
- statement that attachment upload is outside this branch and separately accepted on Staging-20260809-9d12f7e.

Do not copy credentials, cookies, customer identifiers or environment secrets.

- [ ] **Step 6: Commit acceptance evidence**

```powershell
git add docs/portal-entitlement-ui-acceptance.zh-CN.md
git diff --cached --check
git commit -m "docs: record portal entitlement ui verification"
git status --short --branch
```

Expected: clean worktree and only intentional commits ahead of origin/main.

---

## Completion Gate

Implementation is complete only when:

1. Every production behavior was introduced through a witnessed RED/GREEN cycle.
2. Fixed type tabs, counts and default selection follow the approved rules.
3. Current/future/history ordering is deterministic on the Shanghai business date.
4. Numeric and text cards match option B and status styling.
5. Usage records follow selected type.
6. All pages are fetched, including totals over 100.
7. Focused tests, full Web tests, typecheck, lint and build pass.
8. No API, database, attachment or deployment changes exist.
9. Evidence distinguishes automated/local checks from staging checks.
10. Worktree is clean and ready for review.

After the plan is committed, execute it inline with superpowers:executing-plans; do not dispatch subagents.
