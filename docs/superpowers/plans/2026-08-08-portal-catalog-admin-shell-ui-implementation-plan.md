# Portal Catalog and Admin Shell UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. The user has explicitly prohibited subagents for this task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Portal vehicle catalog mobile-safe and customer-readable while making the Admin left navigation scroll and retain expansion state independently from right-side content.

**Architecture:** Keep the existing Portal request/filter/navigation orchestration and Admin authentication/RBAC/menu sources unchanged. Extract pure Portal presentation rules and Admin menu persistence rules into testable helpers, render a dedicated responsive catalog card, and use CSS Modules for the two viewport layouts. Repair the three stale `main` test assertions before feature work so every later checkpoint starts from a clean Web baseline.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 6, Ant Design 6, CSS Modules, Vitest 4, pnpm 11.

**Execution status (2026-08-08):** Tasks 1-8 implemented and locally verified. The feature branch is ready for the integration choice and Staging deployment; no merge has been performed.

## Global Constraints

- Work only in `D:/Projects/auto-subscription-platform/.worktrees/portal-catalog-admin-shell-ui-20260808` on `feat/portal-catalog-admin-shell-ui-20260808`.
- Execute inline with the primary agent; do not dispatch subagents.
- Do not change database models, Prisma migrations, API routes, API response contracts, RBAC, authentication, or business workflows.
- All money values remain stored and received in cents; `monthlyFeeFromAmount = 1` must render as `¥0.01 / 月起`.
- Portal title priority is `shortTitle` → `modelDefinition.customerDisplayName` → safe compatible display → structured brand/model/year fallback; do not show an internal model code as the main title.
- At widths `<= 768px`, the filter is collapsed by default and the vehicle card uses a 16:9 image above its content; desktop keeps a horizontal card.
- Admin route ancestors must always be expanded; leaf navigation must not clear other manually expanded valid menus.
- Restored menu keys must be intersected with the current permission-filtered menu tree; corrupt storage must safely fall back.
- The Admin shell uses `100dvh` with a `100vh` fallback, left/right independent vertical scroll, `min-height: 0`, and `min-width: 0` where required.
- Use TDD for every behavior change: observe a failing focused test, implement the minimum change, then rerun the focused and relevant regression suites.
- Keep commits small and limited to the files named by each task.
- Before changing source, run the repository-required preflight. If migration status fails or reports pending migrations, stop and report the exact state; never run `prisma migrate reset`.

---

## File Structure

### Existing files to modify

- `apps/web/src/app/portal/catalog/page.tsx` — retain catalog API/filter/navigation orchestration and compose the new filter shell and card.
- `apps/web/src/components/protected-shell.tsx` — retain auth/RBAC/account behavior and integrate menu-state persistence plus independent scroll containers.
- `apps/web/test/product-center-access.spec.ts` — point legacy-model assertions at the current vehicle detail action component.
- `apps/web/test/vehicle-insurance-coverage-ui.spec.ts` — assert the current coverage formatter boundary.
- `apps/web/test/vehicle-mileage-view-model.spec.ts` — assert create behavior in the ledger and edit behavior in the current detail action component.

### New focused files

- `apps/web/src/app/portal/catalog/portal-catalog-presentation.ts` — pure title, tag, month, and cents-to-yuan display rules.
- `apps/web/src/app/portal/catalog/portal-catalog-card.tsx` — one responsive vehicle card and image fallback.
- `apps/web/src/app/portal/catalog/portal-catalog-card.module.css` — desktop horizontal and mobile scheme-A card layout.
- `apps/web/src/app/portal/catalog/portal-catalog-filter-panel.tsx` — accessible controlled mobile filter shell that owns no form state.
- `apps/web/src/app/portal/catalog/catalog-page.module.css` — catalog page header, collapsible mobile filter, and list spacing.
- `apps/web/src/lib/admin-menu-state.ts` — module-memory/session-storage state boundary with validation and safe persistence.
- `apps/web/src/components/admin-shell-frame.tsx` — presentation-only Admin viewport frame with menu/header/content slots.
- `apps/web/src/components/protected-shell.module.css` — fixed viewport shell and independent left/right scroll containers.
- `apps/web/test/portal-catalog-presentation.spec.ts` — pure Portal display rule tests.
- `apps/web/test/portal-catalog-card.spec.tsx` — server-rendered catalog card structure and copy tests.
- `apps/web/test/portal-catalog-filter-panel.spec.tsx` — real rendered filter disclosure behavior.
- `apps/web/test/admin-menu-state.spec.ts` — pure menu cache, validation, merge, and scroll-position tests.
- `apps/web/test/admin-shell-layout.spec.tsx` — real rendered Admin viewport-frame structure.

---

### Task 1: Restore a clean Web test baseline after the vehicle workspace move

**Files:**

- Modify: `apps/web/test/product-center-access.spec.ts:6-110`
- Modify: `apps/web/test/vehicle-insurance-coverage-ui.spec.ts:6-17`
- Modify: `apps/web/test/vehicle-mileage-view-model.spec.ts:13-133`
- Read only: `apps/web/src/app/vehicles/page.tsx`
- Read only: `apps/web/src/components/vehicle-workspace/vehicle-detail-actions.tsx`
- Read only: `apps/web/src/components/vehicle-workspace/vehicle-overview-tab.tsx`

**Interfaces:**

- Consumes: the vehicle workspace created on current `main` (`246d2cf`).
- Produces: three tests that validate the same business invariants at their current source boundaries, with no production-code change.

- [ ] **Step 1: Run and record the required repository preflight**

Run each command separately:

```powershell
git status --short
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
pnpm prisma:validate
```

Expected: only the committed design/plan history is present; all 87 migrations are applied; Prisma validation exits 0. Stop before source changes if either Prisma command fails.

- [ ] **Step 2: Reproduce the three stale assertions**

Run:

```powershell
pnpm --filter @subscription-saas/shared build
pnpm --filter @subscription-saas/web test -- product-center-access.spec.ts vehicle-insurance-coverage-ui.spec.ts vehicle-mileage-view-model.spec.ts
```

Expected: 3 test files fail, with one failure in each: missing `saveEditVehicle`, old `insuranceCoverage.*` source text, and an empty old edit-modal slice.

- [ ] **Step 3: Point the legacy-model test at the current edit action component**

Add the current component path and source:

```ts
const vehicleDetailActionsPath =
  "apps/web/src/components/vehicle-workspace/vehicle-detail-actions.tsx";

const vehicleDetailActionsSource = read(vehicleDetailActionsPath);
```

Include `vehicleDetailActionsSource` in the no-legacy-control loop, then replace the stale edit assertion with:

```ts
expect(vehicleDetailActionsSource).toContain('name="modelDefinitionId"');
expect(functionDeclarationSource(vehicleDetailActionsSource, "saveEdit"))
  .not.toContain("vehicleModel");
```

Keep the existing `saveCreateVehicle` assertion against `vehiclesSource` and the package payload assertion against `productsSource`.

- [ ] **Step 4: Point the insurance test at the current formatter contract**

Replace the two stale direct-property strings with the formatter call and helper properties:

```ts
expect(source).toContain("formatInsuranceCoverage(record.insuranceCoverage)");
expect(source).toContain("coverage.compulsoryTraffic");
expect(source).toContain("coverage.commercial");
```

Keep the Chinese “交强险” and “商业险” assertions.

- [ ] **Step 5: Split the mileage assertions across create, detail edit, and overview sources**

Read the three current files:

```ts
const vehiclesPageSource = readFileSync(vehiclesPagePath, "utf8");
const detailActionsSource = readFileSync(
  join(repoRoot, "apps/web/src/components/vehicle-workspace/vehicle-detail-actions.tsx"),
  "utf8"
);
const overviewSource = readFileSync(
  join(repoRoot, "apps/web/src/components/vehicle-workspace/vehicle-overview-tab.tsx"),
  "utf8"
);
```

Assert the current invariant without relying on removed modal offsets:

```ts
expect(vehiclesPageSource).toContain('name="currentMileageKm"');
expect(detailActionsSource).not.toContain('name="currentMileageKm"');
expect(functionDeclarationSource(detailActionsSource, "saveEdit"))
  .not.toContain("currentMileageKm");
expect(detailActionsSource).toContain("当前里程只能通过里程流程单据更新");
expect(overviewSource).toContain('label="当前里程"');
expect(overviewSource).toContain("最近状态/里程事件");
```

Add this exact brace-scanning helper to the mileage test:

```ts
function functionDeclarationSource(source: string, name: string) {
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const openBrace = source.indexOf("{", start);
  expect(openBrace).toBeGreaterThan(start);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to find function body: ${name}`);
}
```

Do not reintroduce `/mileage-readings` or the removed floating edit modal into production code.

- [ ] **Step 6: Run the repaired baseline tests**

Run:

```powershell
pnpm --filter @subscription-saas/web test -- product-center-access.spec.ts vehicle-insurance-coverage-ui.spec.ts vehicle-mileage-view-model.spec.ts
```

Expected: 3 files pass, 23 tests pass.

- [ ] **Step 7: Commit the baseline-only test maintenance**

```powershell
git add apps/web/test/product-center-access.spec.ts apps/web/test/vehicle-insurance-coverage-ui.spec.ts apps/web/test/vehicle-mileage-view-model.spec.ts
git commit -m "test: align vehicle workspace assertions"
```

---

### Task 2: Add tested Portal catalog presentation rules

**Files:**

- Create: `apps/web/src/app/portal/catalog/portal-catalog-presentation.ts`
- Create: `apps/web/test/portal-catalog-presentation.spec.ts`
- Read only: `apps/web/src/lib/portal-types.ts:1-45`

**Interfaces:**

- Consumes: `PortalCatalogVehicle` and its existing cents, title, tag, city, mileage, and registration fields.
- Produces:
  - `buildPortalCatalogTitle(vehicle: PortalCatalogVehicle): string`
  - `buildPortalCatalogTags(vehicle: PortalCatalogVehicle): PortalCatalogTag[]`
  - `formatPortalCatalogMonth(value?: string | null): string | null`
  - `formatPortalCatalogMonthlyFee(amount?: number | null): string`
  - `PortalCatalogTag { color?: "blue" | "green"; label: string }`

- [ ] **Step 1: Write the failing presentation tests**

Create a complete fixture factory with all required `PortalCatalogVehicle` fields, then add these cases:

```ts
it("uses explicit and model-definition customer titles before compatibility fields", () => {
  expect(buildPortalCatalogTitle(vehicle({ shortTitle: "ES6 城市通勤版" })))
    .toBe("ES6 城市通勤版");
  expect(buildPortalCatalogTitle(vehicle({
    shortTitle: null,
    customerModelDisplayName: "NIO/蔚来 ES NIO ES6 2024款 2024款",
    modelDefinition: {
      customerDisplayName: "NIO ES6 2024款",
      displayName: "NIO_ES6_2024",
      id: "model-1",
      modelCode: "NIO_ES6_2024"
    }
  }))).toBe("NIO ES6 2024款");
});

it("does not use the internal model code as the fallback title", () => {
  expect(buildPortalCatalogTitle(vehicle({
    customerModelDisplayName: "NIO_ES6_2024",
    displayName: "NIO_ES6_2024",
    modelCode: "NIO_ES6_2024",
    modelDefinition: null,
    shortTitle: null
  }))).toBe("NIO ES6 2024款");
});

it.each([
  [1, "¥0.01 / 月起"],
  [100, "¥1 / 月起"],
  [12345, "¥123.45 / 月起"],
  [0, "¥0 / 月起"],
  [null, "月租审核后确认"],
  [undefined, "月租审核后确认"]
])("formats monthly fee %s", (amount, expected) => {
  expect(formatPortalCatalogMonthlyFee(amount)).toBe(expected);
});

it("deduplicates explicit and derived tags and excludes displayed facts", () => {
  const tags = buildPortalCatalogTags(vehicle({
    city: "上海市闵行区",
    conditionGrade: "A",
    customerTags: ["75 kWh", "75   kWh", "上海市闵行区"],
    tags: ["BaaS / 电池租用", "75 kWh"],
    hasMajorAccident: false
  }));
  expect(tags.map((tag) => tag.label)).toEqual([
    "75 kWh",
    "BaaS / 电池租用",
    "车况 A",
    "未标记重大事故",
    "押金审核后确认"
  ]);
});
```

The fixture’s structured fallback must be `brand: "NIO"`, `model: "ES6"`, `series: "ES6"`, and `modelYear: 2024`.

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```powershell
pnpm --filter @subscription-saas/web test -- portal-catalog-presentation.spec.ts
```

Expected: FAIL because `portal-catalog-presentation.ts` does not exist.

- [ ] **Step 3: Implement the pure presentation boundary**

Implement the exported interface and functions. Use these exact selection rules:

```ts
export interface PortalCatalogTag {
  color?: "blue" | "green";
  label: string;
}

export function formatPortalCatalogMonthlyFee(amount?: number | null) {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return "月租审核后确认";
  }
  const yuan = (amount / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0
  });
  return `¥${yuan} / 月起`;
}
```

For titles, implement the approved priority with this control flow:

```ts
export function buildPortalCatalogTitle(vehicle: PortalCatalogVehicle) {
  const preferred = cleanText(vehicle.shortTitle)
    ?? cleanText(vehicle.modelDefinition?.customerDisplayName);
  if (preferred) return preferred;

  const internalCode = cleanText(vehicle.modelCode ?? vehicle.modelDefinition?.modelCode);
  for (const candidate of [vehicle.customerModelDisplayName, vehicle.displayName]) {
    const compatible = safeCompatibleTitle(candidate, internalCode);
    if (compatible) return compatible;
  }

  return buildStructuredTitle(vehicle) ?? "待确认车型";
}

function safeCompatibleTitle(value?: string | null, internalCode?: string | null) {
  const title = cleanText(value);
  if (!title) return null;
  if (internalCode && title.toLocaleLowerCase("zh-CN") === internalCode.toLocaleLowerCase("zh-CN")) {
    return null;
  }
  const years = title.match(/\d{4}款/g) ?? [];
  if (new Set(years).size !== years.length) return null;
  return title;
}
```

`cleanText` trims and collapses consecutive whitespace. `buildStructuredTitle` takes non-empty `brand`, `series`, and `model` in that order, removes adjacent case-insensitive duplicates, appends `${modelYear}款` when present, and joins tokens with one space.

For tags, build candidates in this order:

```ts
customerTags → tags → conditionGrade → batteryHealthPercent
→ hasMajorAccident === false → "押金审核后确认"
```

Construct derived candidates explicitly:

```ts
const candidates: PortalCatalogTag[] = [
  ...(vehicle.customerTags ?? []).map((label) => ({ label })),
  ...vehicle.tags.map((label) => ({ label })),
  ...(vehicle.conditionGrade ? [{ color: "blue" as const, label: `车况 ${vehicle.conditionGrade}` }] : []),
  ...(vehicle.batteryHealthPercent !== null && vehicle.batteryHealthPercent !== undefined
    ? [{ color: "green" as const, label: `电池健康度 ${vehicle.batteryHealthPercent}%` }]
    : []),
  ...(vehicle.hasMajorAccident === false
    ? [{ color: "green" as const, label: "未标记重大事故" }]
    : []),
  { label: "押金审核后确认" }
];
```

Normalize comparison keys with `trim()`, collapsed whitespace, and lower casing. Keep the first presentation of a duplicate. Exclude exact normalized matches for the chosen title, city, `${modelYear}款`, `上牌 ${formatPortalCatalogMonth(registrationDate)}`, and `${currentMileageKm.toLocaleString("zh-CN")} km` because those facts render outside the tag region. Treat `batteryHealthPercent = 0` as present. `formatPortalCatalogMonth` returns `null` for an empty or invalid date and otherwise returns `YYYY-MM`.

- [ ] **Step 4: Run the presentation tests**

Run:

```powershell
pnpm --filter @subscription-saas/web test -- portal-catalog-presentation.spec.ts
```

Expected: the new test file passes.

- [ ] **Step 5: Commit the presentation rules**

```powershell
git add apps/web/src/app/portal/catalog/portal-catalog-presentation.ts apps/web/test/portal-catalog-presentation.spec.ts
git commit -m "feat: add portal catalog presentation rules"
```

---

### Task 3: Build the responsive Portal vehicle card

**Files:**

- Create: `apps/web/src/app/portal/catalog/portal-catalog-card.tsx`
- Create: `apps/web/src/app/portal/catalog/portal-catalog-card.module.css`
- Create: `apps/web/test/portal-catalog-card.spec.tsx`
- Consume: `apps/web/src/app/portal/catalog/portal-catalog-presentation.ts`

**Interfaces:**

- Consumes: `PortalCatalogVehicle` plus the four presentation functions from Task 2.
- Produces: `PortalCatalogCard({ vehicle, onDetails }: { vehicle: PortalCatalogVehicle; onDetails: (vehicle: PortalCatalogVehicle) => void }): JSX.Element`.

- [ ] **Step 1: Write the failing server-rendered card tests**

Render with `renderToStaticMarkup` and assert stable semantic hooks:

```tsx
const html = renderToStaticMarkup(
  <PortalCatalogCard onDetails={() => undefined} vehicle={catalogVehicleFixture} />
);

expect(html).toContain('data-testid="portal-catalog-card"');
expect(html).toContain('data-testid="portal-catalog-title"');
expect(html).toContain('data-testid="portal-catalog-location"');
expect(html).toContain('data-testid="portal-catalog-price"');
expect(html).toContain("NIO ES6 2024款");
expect(html).not.toContain("NIO_ES6_2024</");
expect(html).toContain("上牌 2024-08");
expect(html).toContain("20,000 km");
expect(html).toContain("¥0.01 / 月起");
expect(html).toContain("查看详情");
```

Add one fixture with `coverImageUrl: null` and assert a same-region “暂无车辆图片” placeholder, and one with a relative cover URL and an alt value equal to the customer title.

- [ ] **Step 2: Run the card test and verify it fails**

Run:

```powershell
pnpm --filter @subscription-saas/web test -- portal-catalog-card.spec.tsx
```

Expected: FAIL because the card module does not exist.

- [ ] **Step 3: Implement the card component**

Use one Ant Design `List.Item` or semantic `<article>` root with the following structure:

```tsx
<article className={styles.card} data-testid="portal-catalog-card">
  <div className={styles.media}>{/* image or equal-aspect placeholder */}</div>
  <div className={styles.content}>
    <div className={styles.title} data-testid="portal-catalog-title">{title}</div>
    <div className={styles.facts}>{/* registration and mileage */}</div>
    <div className={styles.location} data-testid="portal-catalog-location">{city}</div>
    <div className={styles.tags}>{/* normalized tags */}</div>
    <div className={styles.footer}>
      <strong data-testid="portal-catalog-price">{price}</strong>
      <Button onClick={() => onDetails(vehicle)} type="link">查看详情</Button>
    </div>
  </div>
</article>
```

Keep `buildPortalAssetUrl` beside the image component and continue using `PORTAL_API_BASE_URL`. Use a local `imageFailed` state so `onError` replaces a failed image with the equal-aspect placeholder. Do not render `modelCode` or the current secondary `modelDisplayName` line.

- [ ] **Step 4: Implement the card CSS contract**

Desktop rules:

```css
.card { display: grid; grid-template-columns: 128px minmax(0, 1fr); }
.media { width: 128px; aspect-ratio: 4 / 3; overflow: hidden; }
.content { min-width: 0; }
.tags { display: flex; flex-wrap: wrap; }
.footer { display: flex; align-items: center; justify-content: space-between; }
```

Mobile rules at `@media (max-width: 768px)`:

```css
.card { grid-template-columns: minmax(0, 1fr); padding: 0; overflow: hidden; }
.media { width: 100%; aspect-ratio: 16 / 9; border-radius: 0; }
.content { padding: 16px; }
.title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.location { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

Set image width/height to 100% with `object-fit: cover`; reset Ant Tag inline margins with `:global(.ant-tag)`; make the footer button at least 44px high on mobile. No card descendant may require a width larger than its container.

- [ ] **Step 5: Run the card and presentation tests**

Run:

```powershell
pnpm --filter @subscription-saas/web test -- portal-catalog-card.spec.tsx portal-catalog-presentation.spec.ts
```

Expected: both files pass.

- [ ] **Step 6: Commit the card**

```powershell
git add apps/web/src/app/portal/catalog/portal-catalog-card.tsx apps/web/src/app/portal/catalog/portal-catalog-card.module.css apps/web/test/portal-catalog-card.spec.tsx
git commit -m "feat: add responsive portal vehicle card"
```

---

### Task 4: Integrate the mobile filter shell and card into the catalog page

**Files:**

- Modify: `apps/web/src/app/portal/catalog/page.tsx:1-238`
- Create: `apps/web/src/app/portal/catalog/portal-catalog-filter-panel.tsx`
- Create: `apps/web/src/app/portal/catalog/catalog-page.module.css`
- Create: `apps/web/test/portal-catalog-filter-panel.spec.tsx`
- Consume: `apps/web/src/app/portal/catalog/portal-catalog-card.tsx`

**Interfaces:**

- Consumes: existing `loadVehicles(values)`, `Form<CatalogFilterValues>`, model-definition options, and `router.push` behavior.
- Produces:
  - `PortalCatalogFilterPanel({ activeCount, children, onToggle, open })`
  - one responsive filter form, `appliedFilterCount: number`, and a list composed from `PortalCatalogCard`.

- [ ] **Step 1: Write the failing rendered filter-panel tests**

Render the real disclosure component in its closed and open states:

```tsx
const closed = renderToStaticMarkup(
  <PortalCatalogFilterPanel activeCount={2} onToggle={() => undefined} open={false}>
    <form aria-label="车辆筛选">筛选表单</form>
  </PortalCatalogFilterPanel>
);
expect(closed).toContain('aria-expanded="false"');
expect(closed).toContain("筛选条件（已启用 2 项）");
expect(closed).toContain('data-open="false"');
expect(closed).toContain("筛选表单");

const open = renderToStaticMarkup(
  <PortalCatalogFilterPanel activeCount={0} onToggle={() => undefined} open>
    <form aria-label="车辆筛选">筛选表单</form>
  </PortalCatalogFilterPanel>
);
expect(open).toContain('aria-expanded="true"');
expect(open).toContain("筛选条件");
expect(open).toContain('data-open="true"');
```

- [ ] **Step 2: Run the filter-panel test and verify it fails**

Run:

```powershell
pnpm --filter @subscription-saas/web test -- portal-catalog-filter-panel.spec.tsx
```

Expected: FAIL because `PortalCatalogFilterPanel` does not exist.

- [ ] **Step 3: Implement the controlled filter panel**

`PortalCatalogFilterPanel` owns no form values and renders its children exactly once. Its button uses `aria-controls="portal-catalog-filter-content"`, `aria-expanded={open}`, and the approved active-count copy. The content wrapper uses the matching `id` and `data-open={open ? "true" : "false"}`. Desktop CSS hides the toggle and always displays the content; `@media (max-width: 768px)` hides only `.filterContent[data-open="false"]`.

- [ ] **Step 4: Add one mobile filter state without duplicating the form**

In `PortalCatalogPage`, add:

```ts
const [filtersOpen, setFiltersOpen] = useState(false);
const [appliedFilterCount, setAppliedFilterCount] = useState(0);

const applyFilters = async (values: CatalogFilterValues) => {
  setAppliedFilterCount(
    Object.values(values).filter((value) => typeof value === "string" && value.trim()).length
  );
  await loadVehicles(values);
};
```

Use `applyFilters` only for `Form.onFinish`; keep initial loading through `loadVehicles()` so it does not invent active conditions. Do not auto-close the panel after submit.

Compose the same form through the controlled panel:

```tsx
<PortalCatalogFilterPanel
  activeCount={appliedFilterCount}
  onToggle={() => setFiltersOpen((current) => !current)}
  open={filtersOpen}
>
  <Form<CatalogFilterValues> form={form} layout="vertical" onFinish={applyFilters}>
    {/* the existing fields, exactly once */}
  </Form>
</PortalCatalogFilterPanel>
```

- [ ] **Step 5: Replace the inline list item with the new card**

Keep the existing `List`, loading state, and empty state. Its render function becomes:

```tsx
renderItem={(vehicle) => (
  <PortalCatalogCard
    onDetails={(selected) => router.push(`/portal/catalog/${selected.id}`)}
    vehicle={vehicle}
  />
)}
```

Remove the old `VehicleCoverImage`, `buildPortalAssetUrl`, `formatMonth`, and `formatYuan` functions from `page.tsx`; their responsibilities now belong to the card/presentation files.

- [ ] **Step 6: Move page-level inline layout into the CSS Module**

Create classes for `main`, `container`, `pageHeader`, `filterPanel`, `filterToggle`, `filterContent`, and `filterForm`. At mobile widths:

- use 12px horizontal page padding;
- keep “订阅车辆” and “我的入口” within the header without horizontal overflow;
- make form items one column unless two controls fit naturally;
- make the submit button full-width and at least 44px high;
- ensure `.container`, `.filterPanel`, and the list use `min-width: 0` and `max-width: 100%`.

- [ ] **Step 7: Run all Portal catalog tests**

Run:

```powershell
pnpm --filter @subscription-saas/web test -- portal-catalog-presentation.spec.ts portal-catalog-card.spec.tsx portal-catalog-filter-panel.spec.tsx
```

Expected: all three test files pass.

- [ ] **Step 8: Commit the page integration**

```powershell
git add apps/web/src/app/portal/catalog/page.tsx apps/web/src/app/portal/catalog/portal-catalog-filter-panel.tsx apps/web/src/app/portal/catalog/catalog-page.module.css apps/web/test/portal-catalog-filter-panel.spec.tsx
git commit -m "feat: optimize portal catalog mobile layout"
```

---

### Task 5: Portal checkpoint and browser acceptance

**Files:**

- Verify only: Portal files from Tasks 2-4 and existing Web regressions.

**Interfaces:**

- Consumes: completed Portal implementation.
- Produces: a recorded Portal checkpoint before Admin work begins.

- [ ] **Step 1: Run the focused Portal and repaired baseline tests**

```powershell
pnpm --filter @subscription-saas/web test -- portal-catalog-presentation.spec.ts portal-catalog-card.spec.tsx portal-catalog-filter-panel.spec.tsx product-center-access.spec.ts vehicle-insurance-coverage-ui.spec.ts vehicle-mileage-view-model.spec.ts
```

Expected: all selected files pass.

- [ ] **Step 2: Run Portal-relevant static checks**

```powershell
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
```

Expected: both commands exit 0.

- [ ] **Step 3: Start the Web development server and record its emitted URL**

Run in a long-lived terminal:

```powershell
pnpm --filter @subscription-saas/web dev
```

Use the emitted local URL; do not assume a fixed port if the repository selects another one.

- [ ] **Step 4: Verify the Portal at 360px and 390px**

Using the browser-control skill and a valid Portal session:

1. Open `/portal/catalog` at 360px width.
2. Confirm the page has no horizontal scrollbar.
3. Confirm the filter starts closed, opens by keyboard/click, applies a condition, and reports the active count when closed.
4. Confirm the vehicle image is full-width 16:9, title is at most two lines, location is one line, tags wrap inside the card, and price/detail share the bottom row.
5. Repeat at 390px.
6. Exercise a missing-image or blocked-image case and confirm the placeholder keeps the same aspect region.

Expected: all scheme-A acceptance points pass at both widths.

- [ ] **Step 5: Verify desktop non-regression**

At a desktop width of at least 1280px, confirm the filter is visible without the mobile toggle, cards are horizontal, all filters still call the existing list flow, and “查看详情” opens the original details route.

- [ ] **Step 6: Stop only the development server started by this task**

Do not stop the separate approved visual-companion server or any unrelated local service.

---

### Task 6: Add tested Admin menu state persistence

**Files:**

- Create: `apps/web/src/lib/admin-menu-state.ts`
- Create: `apps/web/test/admin-menu-state.spec.ts`

**Interfaces:**

- Produces:
  - `AdminMenuState { openKeys: string[]; scrollTop: number }`
  - `getAdminMenuState(storage?: AdminMenuStorage | null): AdminMenuState`
  - `resolveAdminMenuOpenKeys(cachedKeys, routeKeys, allowedKeys): string[]`
  - `persistAdminMenuOpenKeys(keys, storage?): void`
  - `persistAdminMenuScrollTop(scrollTop, storage?): void`
  - `resetAdminMenuStateForTests(): void`
  - storage keys `subscription-saas.admin.menu.openKeys` and `subscription-saas.admin.menu.scrollTop`
- Consumed by: Task 7 `ProtectedShell`.

- [ ] **Step 1: Write the failing pure state tests**

Use a Map-backed fake storage and reset module memory after every test:

```ts
afterEach(() => {
  resetAdminMenuStateForTests();
});
```

Cover these exact cases:

```ts
it("reads valid session state on a fresh module state", () => {
  storage.setItem(OPEN_KEYS_STORAGE_KEY, JSON.stringify(["vehicles", "system"]));
  storage.setItem(SCROLL_TOP_STORAGE_KEY, "144");
  expect(getAdminMenuState(storage)).toEqual({
    openKeys: ["vehicles", "system"],
    scrollTop: 144
  });
});

it("prefers module memory across shell remounts", () => {
  persistAdminMenuOpenKeys(["vehicles"], storage);
  storage.setItem(OPEN_KEYS_STORAGE_KEY, JSON.stringify(["system"]));
  expect(getAdminMenuState(storage).openKeys).toEqual(["vehicles"]);
});

it("filters unknown keys and merges required route ancestors", () => {
  expect(resolveAdminMenuOpenKeys(
    ["vehicles", "unknown", "system"],
    ["products"],
    new Set(["vehicles", "system", "products"])
  )).toEqual(["vehicles", "system", "products"]);
});

it.each(["not-json", JSON.stringify({ open: true }), JSON.stringify(["vehicles", 4])])(
  "falls back safely for corrupt open-key storage %s",
  (raw) => {
    storage.setItem(OPEN_KEYS_STORAGE_KEY, raw);
    expect(getAdminMenuState(storage).openKeys).toEqual([]);
  }
);

it("normalizes invalid scroll positions", () => {
  persistAdminMenuScrollTop(-5, storage);
  expect(getAdminMenuState(storage).scrollTop).toBe(0);
});
```

Also test duplicate key removal and a storage implementation whose `getItem`/`setItem` throws; neither path may throw to the caller.

- [ ] **Step 2: Run the state tests and verify they fail**

Run:

```powershell
pnpm --filter @subscription-saas/web test -- admin-menu-state.spec.ts
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement safe module-memory and session-storage state**

Use this storage interface and module boundary:

```ts
export interface AdminMenuStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AdminMenuState {
  openKeys: string[];
  scrollTop: number;
}

let memoryState: AdminMenuState | null = null;
```

`getAdminMenuState` returns a cloned memory state when present; otherwise it safely parses storage, initializes memory, and returns a clone. Open-key JSON is valid only when it is an array containing only strings; deduplicate while preserving order. Scroll position is valid only when finite and non-negative. Every storage call is wrapped in `try/catch` because privacy settings can deny access.

`resolveAdminMenuOpenKeys` applies the allowed-key set to both cached and route keys, concatenates cached first and route ancestors second, and performs stable deduplication. Persistence updates module memory first, then best-effort session storage.

- [ ] **Step 4: Run the state tests**

Run:

```powershell
pnpm --filter @subscription-saas/web test -- admin-menu-state.spec.ts
```

Expected: the new state test file passes.

- [ ] **Step 5: Commit the state boundary**

```powershell
git add apps/web/src/lib/admin-menu-state.ts apps/web/test/admin-menu-state.spec.ts
git commit -m "feat: preserve admin menu ui state"
```

---

### Task 7: Integrate stable menu state and independent Admin scrolling

**Files:**

- Modify: `apps/web/src/components/protected-shell.tsx:21-354`
- Create: `apps/web/src/components/admin-shell-frame.tsx`
- Create: `apps/web/src/components/protected-shell.module.css`
- Create: `apps/web/test/admin-shell-layout.spec.tsx`
- Consume: `apps/web/src/lib/admin-menu-state.ts`
- Regression: `apps/web/test/admin-password-change.spec.tsx`

**Interfaces:**

- Consumes: Task 6 state helpers, existing `findRouteOpenKeys`, permission-filtered `me.menus`, and Ant Design `Menu.onOpenChange`.
- Produces:
  - `AdminShellFrame({ children, header, menu, menuScrollRef, onMenuScroll })`
  - stable controlled `openKeys`, menu scroll restoration, `data-testid="admin-menu-scroll"`, and `data-testid="admin-content-scroll"`.

- [ ] **Step 1: Write the failing rendered frame test**

Render the real presentation frame with literal slots:

```tsx
const menuScrollRef = createRef<HTMLDivElement>();
const html = renderToStaticMarkup(
  <AdminShellFrame
    header={<span>当前用户</span>}
    menu={<nav>车辆资产台账</nav>}
    menuScrollRef={menuScrollRef}
    onMenuScroll={() => undefined}
  >
    <main>详情内容</main>
  </AdminShellFrame>
);

expect(html).toContain('data-testid="admin-menu-scroll"');
expect(html).toContain('data-testid="admin-content-scroll"');
expect(html).toContain("订阅运营中台");
expect(html).toContain("车辆资产台账");
expect(html).toContain("当前用户");
expect(html).toContain("详情内容");
```

The frame is presentation-only: it must not import auth, router, menu state, or API modules.

- [ ] **Step 2: Run the shell integration test and verify it fails**

Run:

```powershell
pnpm --filter @subscription-saas/web test -- admin-shell-layout.spec.tsx
```

Expected: FAIL because `AdminShellFrame` does not exist.

- [ ] **Step 3: Initialize open keys synchronously from the Task 6 state boundary**

Import `useLayoutEffect` and `useRef`. Replace `openKeysRestored` and the mount-only restore effect with a lazy state initializer:

```ts
const [openKeys, setOpenKeys] = useState<string[]>(() =>
  getAdminMenuState(getBrowserSessionStorage()).openKeys
);
const menuScrollRef = useRef<HTMLDivElement | null>(null);
```

`getBrowserSessionStorage()` returns `null` on the server and safely returns `window.sessionStorage` in the browser. It must not throw.

- [ ] **Step 4: Filter cached keys through the visible submenu tree and merge route ancestors**

Add `findVisibleSubmenuKeys(menus, permissions): Set<string>`. It must:

1. filter menus by existing permission rules;
2. derive codes that are actual ancestors of another allowed menu;
3. return only those allowed ancestor codes.

Compute `routeOpenKeys` using the existing `findRouteOpenKeys`. On `me`, pathname, or query-key change, update state with:

```ts
const next = resolveAdminMenuOpenKeys(current, routeOpenKeys, visibleSubmenuKeys);
if (sameKeys(current, next)) return current;
persistAdminMenuOpenKeys(next, getBrowserSessionStorage());
return next;
```

For `Menu.onOpenChange`, resolve the keys supplied by Ant Design against the same allowed set and current route ancestors. This allows users to close unrelated parents while ensuring the active route remains visible. `navigateMenu` continues to set the selected key and call `router.push`; it must not clear or rebuild `openKeys`.

- [ ] **Step 5: Restore and persist the left menu scroll position**

Wrap `Menu` in a ref-backed element:

```tsx
<div
  className={styles.menuViewport}
  data-testid="admin-menu-scroll"
  onScroll={(event) =>
    persistAdminMenuScrollTop(event.currentTarget.scrollTop, getBrowserSessionStorage())
  }
  ref={menuScrollRef}
>
  <Menu ... />
</div>
```

After the authenticated menu is available, use `useLayoutEffect` to set:

```ts
menuScrollRef.current.scrollTop =
  getAdminMenuState(getBrowserSessionStorage()).scrollTop;
```

Do not call smooth scrolling; restoration must not animate.

- [ ] **Step 6: Implement the frame and independent-scroll CSS Module**

`AdminShellFrame` owns the JSX structure and imports `protected-shell.module.css`:

```tsx
<Layout className={styles.shell}>
  <Sider className={styles.sider} ...>
    <div className={styles.siderInner}>
      <div className={styles.brand}>订阅运营中台</div>
      <div className={styles.menuViewport}>...</div>
    </div>
  </Sider>
  <Layout className={styles.rightLayout}>
    <Header className={styles.header}>...</Header>
    <Content className={styles.content} data-testid="admin-content-scroll">
      {children}
    </Content>
  </Layout>
</Layout>
```

It accepts the menu scroll ref/callback from `ProtectedShell`, renders the supplied `menu`, `header`, and `children` slots exactly once, and contains no state.

Implement these essential rules while preserving current colors, 248px Sider width, 64px Header height, and 24px desktop content padding:

```css
.shell { height: 100vh; height: 100dvh; overflow: hidden; }
.sider { height: 100%; overflow: hidden; }
.siderInner { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.brand { flex: none; }
.menuViewport { flex: 1; min-height: 0; overflow-y: auto; }
.rightLayout { height: 100%; min-width: 0; overflow: hidden; }
.header { flex: none; }
.content { flex: 1; min-height: 0; min-width: 0; overflow-y: auto; }
```

At `@media (max-width: 768px)`, set Header horizontal padding to 16px and Content padding to 16px. Do not change Sider’s existing `breakpoint="lg"` and `collapsedWidth="0"` behavior.

- [ ] **Step 7: Run Admin focused and password regressions**

Run:

```powershell
pnpm --filter @subscription-saas/web test -- admin-menu-state.spec.ts admin-shell-layout.spec.tsx admin-password-change.spec.tsx
```

Expected: all selected files pass; account actions and password-change completion behavior remain unchanged.

- [ ] **Step 8: Commit the Admin shell integration**

```powershell
git add apps/web/src/components/protected-shell.tsx apps/web/src/components/admin-shell-frame.tsx apps/web/src/components/protected-shell.module.css apps/web/test/admin-shell-layout.spec.tsx
git commit -m "feat: separate admin navigation scrolling"
```

---

### Task 8: Full verification, browser acceptance, and handoff

**Files:**

- Verify: all files changed in Tasks 1-7.
- Do not create migrations or modify environment secrets.

**Interfaces:**

- Consumes: completed Portal and Admin implementation.
- Produces: evidence suitable for PR review and Staging deployment; no merge occurs in this task.

- [ ] **Step 1: Run the entire Web test suite from a built shared package**

Run separately:

```powershell
pnpm --filter @subscription-saas/shared build
pnpm --filter @subscription-saas/web test
```

Expected: all Web test files pass, including the three repaired baseline files and all new Portal/Admin files.

- [ ] **Step 2: Run Web lint, typecheck, and production build**

Run separately:

```powershell
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
pnpm --filter @subscription-saas/web build
```

Expected: every command exits 0.

- [ ] **Step 3: Re-run repository safety checks**

Run separately:

```powershell
pnpm prisma:validate
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: Prisma validates; all 87 migrations remain applied; diff check is clean; no unintended working-tree files are present.

- [ ] **Step 4: Re-run the Portal browser acceptance**

Repeat Task 5 at 360px, 390px, and desktop width. Explicitly verify long title, long location, many tags, missing image, missing price, 1-cent price, filter count, and detail navigation.

- [ ] **Step 5: Run the Admin browser acceptance**

Using an authenticated Admin session:

1. Open a page with long right-side content and scroll it to the bottom; the left brand/menu position must not change and the Header stays visible.
2. Scroll the left menu; the right content position must not change.
3. Expand one parent and click multiple leaf pages under it; the parent must not close/reopen or replay its expand transition.
4. Expand multiple parents, navigate between leaf pages, and confirm unrelated valid parents remain expanded.
5. Navigate with browser back/forward; the current route ancestor is visible.
6. Refresh; valid menu state and scroll position restore without a visible close/reopen cycle.
7. Put malformed JSON in `subscription-saas.admin.menu.openKeys`, refresh, and confirm the shell safely falls back to the current route ancestor.
8. Confirm Sider mobile collapse/expand, logout, account menu, and password-change entry still work.

- [ ] **Step 6: Review the final diff against the approved design**

Check every acceptance criterion in:

```text
docs/superpowers/specs/2026-08-08-portal-catalog-admin-shell-ui-design.zh-CN.md
```

Confirm there are no API, database, RBAC, authentication, or unrelated vehicle-workspace source changes. If implementation deviated from an approved rule, stop and update the design/plan only after user confirmation.

- [ ] **Step 7: Prepare the handoff summary**

Report:

- changed files and commit list;
- Portal behavior changed;
- Admin behavior changed;
- complete test/lint/typecheck/build output counts;
- Prisma migration status;
- browser widths and scenarios verified;
- known limitations, especially that the shared Next.js Admin layout migration remains out of scope;
- recommended next step: open a review PR, build a new Staging Web image, then perform user acceptance before merge.

### Execution evidence (2026-08-08)

- Shared package build: passed.
- Web full suite: 71 files / 704 tests passed.
- Web lint, TypeScript (`--noEmit --incremental false`), and production build: passed.
- Prisma validate: passed; migration status: 87 migrations found, database schema up to date.
- Portal browser checks: 360px, 390px, and 1280px; no horizontal overflow; responsive media/title/location/tags/price/filter behavior passed.
- Admin browser checks: independent left/right scrolling, leaf navigation without parent collapse, multiple preserved parents, and refresh restoration passed.
- Final scope review: Web UI/tests/docs only; no API, database, RBAC, authentication-contract, or business-flow changes.
