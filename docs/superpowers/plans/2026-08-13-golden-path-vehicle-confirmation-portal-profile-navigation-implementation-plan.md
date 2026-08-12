# Golden Path Final Vehicle Confirmation and Portal Profile Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove manual vehicle UUID entry from the Golden Path final-vehicle decision and expose the existing Portal basic-profile form through a unified “基本资料 / 证件材料” navigation.

**Architecture:** Extend the allowlisted Admin Journey application projection with the already persisted final vehicle facts, then derive a small, typed confirmation view model from that projection. Keep the existing audited allocation command as the only mutation. Add a shared Portal profile navigation component and pure URL helpers so both existing routes remain compatible and preserve safe Portal-local return targets.

**Tech Stack:** NestJS, Prisma, React 19, Next.js 16 App Router, Ant Design 6, TypeScript 6, Vitest, pnpm workspace.

## Global Constraints

- Work only in `D:/Projects/auto-subscription-platform/.worktrees/golden-path-vehicle-profile-ui-20260813` on `fix/golden-path-vehicle-profile-ui-20260813`.
- Preserve the existing `FINAL_VEHICLE_ALLOCATION` manual decision, optimistic version check, audit trail, vehicle hold rules, and allocation API.
- Never render or request a manually typed vehicle UUID for final vehicle allocation.
- Use only `application.finalVehicleId` returned by the server as the allocation command input.
- Do not add a database migration or change the Portal profile/material APIs.
- Preserve `/portal/me`, `/portal/materials`, and safe Portal-local `redirect` values.
- Use TDD: each production behavior starts with a focused test that is observed failing for the intended reason.
- Build and deploy API/Web from the merge commit on the latest remote `main`; staging API and Web containers must each reference that exact image tag without overlay images.

---

## File Structure

- `apps/api/src/subscription-journey/subscription-journey.service.ts`: allowlisted Admin Journey projection fields.
- `apps/api/test/subscription-journey-recovery.spec.ts`: API projection regression coverage.
- `apps/web/src/lib/subscription-journey-view-model.ts`: typed final-vehicle confirmation derivation.
- `apps/web/src/components/subscription-journey/application-journey-actions.tsx`: readable confirmation card and allocation action.
- `apps/web/test/subscription-journey-admin-ui.spec.tsx`: Admin action rendering regressions.
- `apps/web/src/lib/portal-profile-navigation.ts`: safe return-target and profile-tab URL helpers.
- `apps/web/src/components/portal/portal-profile-tabs.tsx`: shared profile navigation.
- `apps/web/src/app/portal/me/page.tsx`: basic-profile tab integration and safe return handling.
- `apps/web/src/app/portal/materials/page.tsx`: materials-tab integration and safe return handling.
- `apps/web/src/app/portal/page.tsx`: default “我的资料” entry route.
- `apps/web/test/portal-profile-navigation.spec.tsx`: profile navigation and redirect regressions.
- `docs/superpowers/specs/2026-08-13-golden-path-vehicle-confirmation-portal-profile-navigation-design.zh-CN.md`: approved behavior and acceptance source.

---

### Task 1: Extend the Admin Journey application projection

**Files:**
- Modify: `apps/api/test/subscription-journey-recovery.spec.ts`
- Modify: `apps/api/src/subscription-journey/subscription-journey.service.ts`

**Interfaces:**
- Consumes: persisted `Application.applicationSource`, `Application.finalVehicleId`, `Application.finalPlanSnapshot`, and `Application.softReservedVehicleId`.
- Produces: `projection.application` with `applicationSource`, `finalVehicleId`, `finalPlanSnapshot`, and `softReservedVehicleId` for Admin callers only.

- [ ] **Step 1: Write the failing projection test**

Extend the existing allowlist test row with final vehicle facts and assert the real service response:

```ts
row.application = {
  ...row.application,
  applicationSource: "SELF_SERVICE",
  finalVehicleId: "vehicle-1",
  finalPlanSnapshot: {
    vehicleSnapshot: {
      brand: "NIO",
      model: "ES6",
      plateNo: "沪DGU578",
      vehicleNo: "VEH20260807061849KRNM",
      vin: "VIN-1"
    }
  },
  softReservedVehicleId: "vehicle-1"
};
expect(projection.application).toMatchObject({
  applicationSource: "SELF_SERVICE",
  finalVehicleId: "vehicle-1",
  softReservedVehicleId: "vehicle-1"
});
expect(projection.application.finalPlanSnapshot).toEqual(row.application.finalPlanSnapshot);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-recovery.spec.ts
```

Expected: the new fields are absent from the Prisma select/projection type or response.

- [ ] **Step 3: Add the minimal allowlisted fields**

Add exactly these selections under `adminJourneyInclude.application.select`:

```ts
applicationSource: true,
finalPlanSnapshot: true,
finalVehicleId: true,
```

Keep returning `journey.application`; Prisma now constrains that object to the expanded allowlist.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same Vitest command. Expected: all tests in the file pass.

- [ ] **Step 5: Commit the API projection increment**

```powershell
git add apps/api/src/subscription-journey/subscription-journey.service.ts apps/api/test/subscription-journey-recovery.spec.ts
git commit -m "fix: expose journey final vehicle facts"
```

---

### Task 2: Replace Admin vehicle UUID entry with a server-backed confirmation

**Files:**
- Modify: `apps/web/test/subscription-journey-admin-ui.spec.tsx`
- Modify: `apps/web/src/lib/subscription-journey-view-model.ts`
- Modify: `apps/web/src/components/subscription-journey/application-journey-actions.tsx`

**Interfaces:**
- Consumes: `AdminSubscriptionJourney.application` fields from Task 1.
- Produces: `getJourneyVehicleConfirmation(journey)` returning `{ actionLabel, blockedReason, title, vehicleId, vehicle }`, where `vehicleId` is either the server-returned final ID or `null`.

- [ ] **Step 1: Write failing UI tests for same-vehicle and missing-vehicle states**

Render `ApplicationJourneyActions` with the allocate permission and a self-service final vehicle:

```tsx
const html = renderToStaticMarkup(
  <ApplicationJourneyActions
    journey={journey({
      application: {
        applicationNo: "APP-1",
        applicationSource: "SELF_SERVICE",
        finalPlanSnapshot: { vehicleSnapshot: { brand: "NIO", model: "ES6", plateNo: "沪DGU578", vehicleNo: "VEH-1", vin: "VIN-1" } },
        finalVehicleId: "vehicle-1",
        id: "application-1",
        softReservedVehicleId: "vehicle-1",
        status: "APPROVED"
      },
      availableActions: ["FINAL_VEHICLE_ALLOCATION"],
      currentStepCode: "FINAL_VEHICLE_ALLOCATION",
      currentStepStatus: "WAITING_MANUAL"
    })}
    onChanged={vi.fn()}
    permissions={new Set(["subscription_journey:vehicle_allocate"])}
  />
);
expect(html).toContain("已软锁车辆");
expect(html).toContain("确认沿用已软锁车辆");
expect(html).toContain("VEH-1");
expect(html).toContain("NIO ES6");
expect(html).not.toContain("分配车辆 ID");
```

Add a second render with `finalVehicleId: null` and assert:

```ts
expect(html).toContain("最终方案缺少车辆，请返回最终方案步骤选择车辆");
expect(html).not.toContain("确认最终车辆");
expect(html).not.toContain("确认沿用已软锁车辆");
```

- [ ] **Step 2: Run the focused web test and verify RED**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/subscription-journey-admin-ui.spec.tsx
```

Expected: existing UUID input/button markup differs from both required states.

- [ ] **Step 3: Implement the typed confirmation view model**

Expand `AdminSubscriptionJourney.application` with optional/null JSON-safe fields. Add a pure helper that:

```ts
const sameSoftLockedVehicle =
  application.applicationSource === "SELF_SERVICE" &&
  application.finalVehicleId === application.softReservedVehicleId;
```

It must read string values only from `finalPlanSnapshot.vehicleSnapshot`, join brand/model for display, return `-` for absent display facts, choose “已软锁车辆 / 确认沿用已软锁车辆” for the same-vehicle case, choose “最终车辆 / 确认最终车辆” for other existing final vehicles, and return the approved blocking text with `vehicleId: null` when absent.

- [ ] **Step 4: Implement the minimal Admin component**

Remove the `vehicleId` state and both vehicle UUID input branches. Call the helper once, display an Ant Design `Descriptions` or compact bordered block with 车辆编号、品牌/车型、车牌号、VIN, and submit only:

```ts
allocateJourneyVehicle(journey.id, {
  vehicleId: confirmation.vehicleId,
  version: journey.version
})
```

Render an `Alert` and no allocation button when blocked. Keep `runJourneyMutation`, loading, refresh, API business errors, and permissions unchanged.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the same web Vitest command. Expected: all tests pass and the old UUID input is absent.

- [ ] **Step 6: Commit the Admin UI increment**

```powershell
git add apps/web/src/lib/subscription-journey-view-model.ts apps/web/src/components/subscription-journey/application-journey-actions.tsx apps/web/test/subscription-journey-admin-ui.spec.tsx
git commit -m "fix: confirm the journey final vehicle without uuid entry"
```

---

### Task 3: Unify Portal profile navigation

**Files:**
- Create: `apps/web/src/lib/portal-profile-navigation.ts`
- Create: `apps/web/src/components/portal/portal-profile-tabs.tsx`
- Create: `apps/web/test/portal-profile-navigation.spec.tsx`
- Modify: `apps/web/src/app/portal/me/page.tsx`
- Modify: `apps/web/src/app/portal/materials/page.tsx`
- Modify: `apps/web/src/app/portal/page.tsx`

**Interfaces:**
- Produces: `normalizePortalRedirect(value: string | null | undefined): string | null`.
- Produces: `buildPortalProfileHref(tab: "basic" | "materials", redirect?: string | null): string`.
- Produces: `<PortalProfileTabs activeTab="basic" | "materials" redirect={...} />`.

- [ ] **Step 1: Write failing navigation tests**

Test the public behavior of the wished-for helpers and component:

```ts
expect(buildPortalProfileHref("basic", "/portal/catalog/vehicle-1"))
  .toBe("/portal/me?redirect=%2Fportal%2Fcatalog%2Fvehicle-1");
expect(buildPortalProfileHref("materials", "https://evil.example"))
  .toBe("/portal/materials");
const html = renderToStaticMarkup(<PortalProfileTabs activeTab="basic" redirect="/portal/catalog" />);
expect(html).toContain("基本资料");
expect(html).toContain("证件材料");
expect(html).toContain("/portal/materials?redirect=%2Fportal%2Fcatalog");
```

Include normalization assertions that accept `/portal` and `/portal/...`, reject protocol-relative `//evil.example`, reject external URLs, and reject non-Portal paths.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/portal-profile-navigation.spec.tsx
```

Expected: imports fail because the new helper/component do not exist.

- [ ] **Step 3: Implement the pure navigation helper and component**

The normalizer must use this boundary:

```ts
if (value === "/portal" || value.startsWith("/portal/")) return value;
return null;
```

It must reject values beginning `//` before the Portal prefix check. The URL builder maps `basic` to `/portal/me`, `materials` to `/portal/materials`, and appends a URL-encoded safe redirect. The component renders Ant Design `Tabs` whose labels are Next `Link` elements using those URLs.

- [ ] **Step 4: Integrate both existing pages and the home entry**

On `/portal/me`, normalize `searchParams.get("redirect")`, render the shared tabs above the profile form, and use the normalized value for post-save navigation.

On `/portal/materials`, derive the normalized redirect from the browser query, render the shared tabs above the material content, use `/portal` as the back-button fallback, and preserve `/portal/materials` as the login return page.

Change only the Portal home entry:

```ts
{ href: "/portal/me", icon: <IdcardOutlined />, title: "我的资料" }
```

- [ ] **Step 5: Run the focused tests and verify GREEN**

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/portal-profile-navigation.spec.tsx test/portal-profile-page.spec.tsx test/portal-profile-form.spec.ts
```

Expected: navigation, existing profile conversion, and material behaviors pass.

- [ ] **Step 6: Commit the Portal navigation increment**

```powershell
git add apps/web/src/lib/portal-profile-navigation.ts apps/web/src/components/portal/portal-profile-tabs.tsx apps/web/src/app/portal/me/page.tsx apps/web/src/app/portal/materials/page.tsx apps/web/src/app/portal/page.tsx apps/web/test/portal-profile-navigation.spec.tsx
git commit -m "fix: expose portal basic profile navigation"
```

---

### Task 4: Verify, publish, and deploy the merged revision

**Files:**
- Modify only if an observed failure requires an in-scope correction.

**Interfaces:**
- Consumes: all implementation commits.
- Produces: merged PR, exact API/Web image tag from the merge commit, staging containers using those images, and deployment evidence.

- [ ] **Step 1: Run focused regression tests**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-journey-recovery.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/subscription-journey-admin-ui.spec.tsx test/portal-profile-navigation.spec.tsx test/portal-profile-page.spec.tsx test/portal-profile-form.spec.ts
```

- [ ] **Step 2: Run repository quality gates**

```powershell
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
pnpm -r lint
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/web test
```

Record exact command outcomes. Do not claim completion if any command fails.

- [ ] **Step 3: Verify scope and migration state**

```powershell
git status --short
git diff origin/main...HEAD --stat
git diff --check origin/main...HEAD
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

If the local migration command lacks the staging database URL, run the same status command in the staging API one-off container. Expected: schema is up to date and no new migration exists.

- [ ] **Step 4: Push, create PR, and merge**

Push `fix/golden-path-vehicle-profile-ui-20260813`, create a PR summarizing behavior and verification evidence, inspect checks, then merge without force-pushing or rewriting user history. Fetch `origin/main` and record the merge SHA.

- [ ] **Step 5: Build and publish exact API/Web images**

Switch/build from a clean checkout of the fetched merge SHA. Use one immutable tag derived from the merge commit for both `subscription-api` and `subscription-web`. Push both images to the configured registry and confirm both remote manifests resolve.

- [ ] **Step 6: Deploy staging and verify one-to-one image mapping**

Using `D:/139.196.227.195_id_ed25519`, update the server’s controlled staging configuration to the new API/Web tags, pull, and recreate only the intended services. Confirm each running container’s image reference and immutable image ID match its published target; do not commit or expose the private key.

- [ ] **Step 7: Confirm database and smoke health**

Run Prisma migration status in the deployed API container (no migration deployment is expected), then check API health, Admin application page loading, Portal basic profile page loading, Portal materials page loading, and recent container logs for startup/runtime errors.

- [ ] **Step 8: Handoff for manual acceptance**

Report PR/merge identifiers, image tags, container/image mapping, migration status, smoke results, and the exact manual acceptance checklist from the approved design.
