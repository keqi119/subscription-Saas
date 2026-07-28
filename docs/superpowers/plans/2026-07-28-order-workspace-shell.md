# Admin Order Workspace Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the long Admin order-detail page with a compact, high-density order workspace that gives operators a server-derived next-action guide and seven stable transaction tabs without changing domain write ownership.

**Architecture:** Add a read-only workspace summary endpoint that aggregates safe header context and current domain state into deterministic guidance items. The Web page keeps existing typed domain APIs and action handlers, but mounts their panels inside a URL-addressable workspace shell. Only the workspace summary loads initially; each transaction tab loads its own domain data on first activation.

**Tech Stack:** NestJS, Prisma, Vitest, Next.js App Router, React, Ant Design, TanStack Query.

## Global Constraints

- Implement against the approved design in `docs/superpowers/specs/2026-07-28-order-workspace-design.md`.
- Do not add a database migration in this plan.
- Do not move domain writes into a generic workspace endpoint.
- Do not duplicate contract, handover, entitlement, service-case, finance, or order-change source records.
- Preserve every existing permission check and action endpoint.
- Keep Stage 2 delivery gating based on signature completion, not signed-file archive completion.
- The first viewport must show the compact order header, current-transaction guide, and tab strip.
- Do not add marketing copy, decorative cards, gradients, or oversized headings.

---

## Task 1: Define the Workspace Summary Contract

**Files:**
- Create: `apps/api/src/order/order-workspace.types.ts`
- Create: `apps/api/test/order-workspace.spec.ts`

- [ ] Define these stable API types:

```ts
export type OrderWorkspaceTabKey =
  | "overview"
  | "contract"
  | "handover"
  | "entitlement"
  | "service"
  | "finance"
  | "change";

export type OrderWorkspaceState =
  | "BLOCKED"
  | "ACTION_REQUIRED"
  | "FAILED"
  | "PROCESSING"
  | "WAITING_EXTERNAL"
  | "READY"
  | "COMPLETED"
  | "NOT_STARTED"
  | "UNAVAILABLE";

export type OrderWorkspaceGuideCategory = Exclude<
  OrderWorkspaceTabKey,
  "overview"
>;

export type OrderWorkspaceTarget = {
  actionCode: string;
  targetTab: OrderWorkspaceGuideCategory;
  targetRecordId: string | null;
};

export type OrderWorkspaceGuideItem = {
  category: OrderWorkspaceGuideCategory;
  state: OrderWorkspaceState;
  priority: number;
  actionCode: string | null;
  reasonCode: string;
  targetTab: OrderWorkspaceGuideCategory;
  targetRecordId: string | null;
  blocking: boolean;
  updatedAt: string | null;
  additionalCount: number;
};

export type OrderWorkspaceSummary = {
  asOf: string;
  header: {
    orderId: string;
    orderNo: string;
    orderStatus: string;
    customerLabel: string;
    currentVehicleLabel: string | null;
    ownerLabel: string | null;
  };
  guidance: OrderWorkspaceGuideItem[];
  primaryAction: OrderWorkspaceTarget | null;
  tabBadges: Array<{
    tab: OrderWorkspaceTabKey;
    count: number;
    attentionCount: number;
  }>;
  recentActivity: Array<{
    id: string;
    category: OrderWorkspaceGuideCategory | "order";
    title: string;
    occurredAt: string;
    targetTab: OrderWorkspaceTabKey;
    targetRecordId: string | null;
  }>;
};
```

- [ ] In the test file, encode the fixed status priority:

```ts
const WORKSPACE_STATE_PRIORITY = [
  "BLOCKED",
  "ACTION_REQUIRED",
  "FAILED",
  "PROCESSING",
  "WAITING_EXTERNAL",
  "READY",
  "COMPLETED",
  "NOT_STARTED",
  "UNAVAILABLE",
] as const;
```

- [ ] Add tests proving a fully authorized Admin receives exactly six guidance entries in this order: `contract`, `handover`, `entitlement`, `service`, `finance`, `change`.
- [ ] Add tests proving a restricted user receives only permitted tab badges and guidance values, and receives status without an action when they have view permission but lack action permission.
- [ ] Add tests proving `primaryAction` selects the first actionable item by fixed state priority, then oldest required-action timestamp, then record ID, and returns `null` when all visible entries are completed, not started, or unavailable.
- [ ] Add tests proving all returned targets are `?tab=<tabKey>&focus=<recordId>` compatible.
- [ ] Add tests proving `asOf`, safe header context, tab badges, and the bounded `recentActivity` array are present. In Phase 1, return an empty array rather than synthesizing history; the activity plan populates it from `OrderActivityEvent`.
- [ ] Run the test and confirm it fails because the types and resolver do not exist:

```powershell
pnpm --filter @subscription-saas/api test -- test/order-workspace.spec.ts
```

- [ ] Commit the contract and failing test only after confirming the failure is the intended missing-implementation failure:

```powershell
git add apps/api/src/order/order-workspace.types.ts apps/api/test/order-workspace.spec.ts
git commit -m "test: define order workspace summary contract"
```

---

## Task 2: Implement the Server-Side Summary Resolver

**Files:**
- Create: `apps/api/src/order/order-workspace.service.ts`
- Modify: `apps/api/src/order/order.module.ts`
- Modify: `apps/api/src/order/order.controller.ts`
- Modify: `apps/api/test/order-workspace.spec.ts`

- [ ] Implement pure resolver helpers in `order-workspace.service.ts` for the six categories. Each helper accepts already permission-filtered domain facts and returns one `OrderWorkspaceGuideItem`.
- [ ] Use these category rules and return stable `reasonCode` and `actionCode` values rather than provider text:

| Category | Actionable examples | Completed boundary |
| --- | --- | --- |
| Contract | missing required contract, signature pending, signature failure | required Stage 1 contract/package records signed |
| Handover | Field not assigned, customer review pending, signing not initiated after 15 minutes, signer pending, signing failure | Stage 2 signatures complete; archival may remain processing |
| Entitlement | activation/reconciliation required | all currently due entitlement actions complete |
| Service | open service case requiring operator action | no operator-actionable open case |
| Finance | payment, reconciliation, refund, deposit settlement due | no currently due finance action |
| Change | pending approval or failed change workflow | no pending/failed change |

- [ ] Fetch order scope and all required summary facts in bounded Prisma queries. Select only identifiers, statuses, counts, and timestamps needed by the resolvers.
- [ ] Reuse the existing order access/sales-scope predicate before reading any domain facts.
- [ ] Ensure the summary endpoint never returns raw provider responses, object keys, ID-card numbers, phone numbers, or payment credentials.
- [ ] Add `GET /orders/:id/workspace/summary` to `OrderController` using the existing order-view permission boundary.
- [ ] Register `OrderWorkspaceService` in `OrderModule`. Reuse `OrderService` for the initial order access/sales-scope check, then use bounded Prisma selects for the six read-only category summaries.
- [ ] Resolve each category independently. Convert a contributor failure to `UNAVAILABLE` with no action so one failed domain does not blank the rest of the summary.
- [ ] Expand tests for:
  - ordinary Field non-progression before and after 15 minutes;
  - both Stage 2 signers complete while archive is pending;
  - failed Stage 2 provider flow;
  - sales-scope denial;
  - contract and finance issues competing for recommendation;
  - all categories complete;
  - one failed contributor while the other categories remain available.
- [ ] Re-run the API test and confirm it passes:

```powershell
pnpm --filter @subscription-saas/api test -- test/order-workspace.spec.ts
```

- [ ] Commit this task:

```powershell
git add apps/api/src/order/order-workspace.service.ts apps/api/src/order/order.module.ts apps/api/src/order/order.controller.ts apps/api/test/order-workspace.spec.ts
git commit -m "feat: add order workspace summary"
```

---

## Task 3: Build the Web Workspace View Model

**Files:**
- Create: `apps/web/src/lib/admin-order-workspace.ts`
- Create: `apps/web/test/admin-order-workspace.spec.ts`

- [ ] Mirror the API discriminated unions in the Web helper without broad `string` fallbacks.
- [ ] Implement:

```ts
export function parseOrderWorkspaceLocation(
  searchParams: URLSearchParams,
): { tab: OrderWorkspaceTabKey; focus?: string };

export function buildOrderWorkspaceLocation(input: {
  orderId: string;
  tab: OrderWorkspaceTabKey;
  focus?: string;
}): string;

export function getWorkspaceStatePresentation(
  state: OrderWorkspaceState,
): { label: string; color: string };

export function getWorkspaceActionPresentation(
  actionCode: string,
): { label: string; icon: string } | null;
```

- [ ] Add tests for every valid tab, an invalid tab falling back to `overview`, focus encoding, focus omission, and all status labels.
- [ ] Add a test proving guidance actions and tab clicks use the same URL builder.
- [ ] Add tests proving unknown action codes fail closed by returning no enabled action.
- [ ] Run the test and confirm it fails before the helper exists:

```powershell
pnpm --filter @subscription-saas/web test -- test/admin-order-workspace.spec.ts
```

- [ ] Implement the helper with `URLSearchParams`; do not concatenate raw query strings.
- [ ] Re-run the test and confirm it passes.
- [ ] Commit this task:

```powershell
git add apps/web/src/lib/admin-order-workspace.ts apps/web/test/admin-order-workspace.spec.ts
git commit -m "feat: add order workspace navigation model"
```

---

## Task 4: Create the High-Density Workspace Shell

**Files:**
- Create: `apps/web/src/components/order-workspace/order-workspace-header.tsx`
- Create: `apps/web/src/components/order-workspace/order-transaction-guide.tsx`
- Create: `apps/web/src/components/order-workspace/order-workspace.tsx`
- Modify: `apps/web/test/admin-order-workspace.spec.ts`

- [ ] Add component-level source assertions or render tests covering the seven visible tab labels:
  - `订单基本信息`
  - `主合同及订阅套餐`
  - `车辆交接`
  - `订阅权益`
  - `用车中事务`
  - `财务/收款核销`
  - `变更/历史快照`
- [ ] Add tests proving a fully authorized summary renders six compact guidance items, exposes one primary action, and preserves secondary category actions.
- [ ] Run the Web test and confirm the component assertions fail:

```powershell
pnpm --filter @subscription-saas/web test -- test/admin-order-workspace.spec.ts
```

- [ ] Build `OrderWorkspaceHeader` as one compact band containing back navigation, order number, current lifecycle status, customer, vehicle, owner/sales person, refresh, and an order-level overflow menu. Remove Stage 1-specific `生成合同` and `查看合同` from this global header.
- [ ] Build `OrderTransactionGuide` using the restrained status/shortcut language already used by the reports page. Use small status marks, concise state text, timestamps, and icon-backed actions.
- [ ] Build `OrderWorkspace` with a stable tab strip and a single active content region. Accept tab content as typed `ReactNode` slots so existing domain panels can be migrated without duplicating their logic.
- [ ] Keep dimensions stable: a one-line desktop header where possible, a horizontally scrollable tab strip at narrow widths, and no nested cards.
- [ ] Re-run the Web test and confirm it passes.
- [ ] Commit this task:

```powershell
git add apps/web/src/components/order-workspace/order-workspace-header.tsx apps/web/src/components/order-workspace/order-transaction-guide.tsx apps/web/src/components/order-workspace/order-workspace.tsx apps/web/test/admin-order-workspace.spec.ts
git commit -m "feat: build admin order workspace shell"
```

---

## Task 5: Migrate the Existing Order Page into Seven Tabs

**Files:**
- Modify: `apps/web/src/app/orders/[id]/page.tsx`
- Modify: `apps/web/test/admin-order-workspace.spec.ts`
- Modify: `apps/web/test/admin-stage2-handover-esign.spec.ts`

- [ ] Add regression tests proving existing Stage 1 contract/package actions appear only in the contract tab and Stage 2 actions appear only in the handover tab.
- [ ] Add regression tests proving Admin Stage 2 fallback initiation, signed-PDF selection, archive retry state, and delivery confirmation remain available with their existing permissions.
- [ ] Add tests proving a direct `?tab=handover&focus=<workOrderId>` load activates the handover tab and marks the focused row for scrolling/highlight after data arrives.
- [ ] Run the focused tests and confirm they fail against the long-form page:

```powershell
pnpm --filter @subscription-saas/web test -- test/admin-order-workspace.spec.ts test/admin-stage2-handover-esign.spec.ts
```

- [ ] Load only `/orders/:id/workspace/summary` on first render; it supplies the safe header context, guidance, tab badges, and bounded activity preview.
- [ ] Use the URL as the active-tab source of truth. Tab changes must call `router.replace(buildOrderWorkspaceLocation(...), { scroll: false })`.
- [ ] Render only the active tab body so inactive domain panels do not run their effects. Cache data already loaded during the current page session.
- [ ] Give each active tab an isolated loading, error, empty, and retry state. A failed tab must not replace the header, guidance, or another tab's cached data.
- [ ] Map existing content without changing domain semantics:

| Tab | Existing content to move |
| --- | --- |
| Overview | order/customer/vehicle facts, current lifecycle state, compact milestone summary |
| Contract | Stage 1 contracts, subscription package, quote snapshot |
| Handover | delivery preparation, Stage 2 Field/customer review/signing, returns, deposit handover-related steps |
| Entitlement | entitlement activation, usage, reconciliation |
| Service | order-filtered service cases and links to existing service-case detail |
| Finance | payment, receipt reconciliation, refund, deposit settlement |
| Change | active change request, approvals, completed changes, history snapshots |

- [ ] Keep existing modal components outside the tab body so opening a modal does not remount unrelated page state.
- [ ] Implement focus handling after the active tab data resolves: find `[data-workspace-record="<focus>"]`, scroll it into view, and apply a temporary restrained highlight.
- [ ] Remove the former stacked panel sequence after all panels are reachable from the tabs.
- [ ] Re-run the focused tests and confirm they pass.
- [ ] Commit this task:

```powershell
git add "apps/web/src/app/orders/[id]/page.tsx" apps/web/test/admin-order-workspace.spec.ts apps/web/test/admin-stage2-handover-esign.spec.ts
git commit -m "refactor: turn order detail into workspace tabs"
```

---

## Task 6: Verify the Complete Workspace Experience

**Files:**
- Verify only.

- [ ] Run the affected suites:

```powershell
pnpm --filter @subscription-saas/api test -- test/order-workspace.spec.ts test/order-contract.spec.ts test/stage2-handover-esign-lifecycle.spec.ts
pnpm --filter @subscription-saas/web test -- test/admin-order-workspace.spec.ts test/admin-stage2-handover-esign.spec.ts
```

- [ ] Run typecheck, lint, and builds:

```powershell
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/api build
pnpm --filter @subscription-saas/web build
```

- [ ] Start the API and Web development servers on available ports.
- [ ] Verify with Playwright at 1440x900, 1280x800, and 390x844.
- [ ] Capture screenshots showing:
  - the header, guide, and tabs in the first viewport;
  - the handover tab with Stage 2 details;
  - the finance tab;
  - the change tab;
  - the mobile tab strip and non-overlapping actions.
- [ ] Confirm no button text clips, no tab content overlaps, and the page no longer renders as one long stack.
- [ ] Confirm direct URLs for all seven tabs survive refresh and browser back/forward navigation.
- [ ] Push the branch, open a PR, obtain review, and merge only after automated and visual checks pass.
