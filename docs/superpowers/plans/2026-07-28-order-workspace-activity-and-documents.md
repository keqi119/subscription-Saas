# Order Workspace Activity and Related Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable, idempotent order activity projection for operator-readable milestones, deepen the in-use service view, and provide permission-safe related-document discovery inside the order workspace.

**Architecture:** Domain tables remain authoritative. A new append-only `OrderActivityEvent` projection stores normalized business milestones with deterministic idempotency keys and links back to source records. A separate read-only document index discovers authoritative domain-owned files and exposes safe metadata; it does not own, copy, or reclassify documents.

**Tech Stack:** PostgreSQL, Prisma, NestJS, Vitest, Next.js App Router, React, Ant Design.

## Global Constraints

- Begin only after the order workspace shell plan is merged.
- All new projection writes must be idempotent and retry-safe.
- Do not use `AuditLog` directly as the operator timeline.
- Do not infer or fabricate historical milestones that cannot be proven from source state.
- Do not move files into an order-owned storage bucket or duplicate `FileObject` records.
- Never return object keys, provider payloads, ID-card numbers, raw phone numbers, or payment credentials.
- Keep source-domain links permission checked on every request.
- Migration deployment and historical backfill are separate operational steps.

---

## Task 1: Add the Order Activity Projection Schema

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260728190000_add_order_activity_event/migration.sql`
- Create: `apps/api/test/order-activity-schema.spec.ts`

- [ ] Add a schema test proving the migration creates one append-only event table, one unique idempotency constraint, and the required order/time and source lookup indexes.
- [ ] Define:

```prisma
enum OrderWorkspaceCategory {
  ORDER
  CONTRACT
  HANDOVER
  ENTITLEMENT
  SERVICE
  FINANCE
  CHANGE
}

model OrderActivityEvent {
  id             String                 @id @default(uuid()) @db.Uuid
  orderId        String                 @db.Uuid
  category       OrderWorkspaceCategory
  eventType      String                 @db.VarChar(96)
  title          String                 @db.VarChar(160)
  summary        String?                @db.VarChar(500)
  sourceType     String                 @db.VarChar(96)
  sourceId       String                 @db.VarChar(128)
  actorType      String?                @db.VarChar(64)
  actorId        String?                @db.VarChar(128)
  actorDisplay   String?                @db.VarChar(160)
  occurredAt     DateTime
  targetTab      String                 @db.VarChar(32)
  targetRecordId String?                @db.VarChar(128)
  idempotencyKey String                 @unique @db.VarChar(220)
  metadata       Json?
  createdAt      DateTime               @default(now())

  order SubscriptionOrder @relation(fields: [orderId], references: [id], onDelete: Cascade)

  @@index([orderId, occurredAt(sort: Desc)])
  @@index([sourceType, sourceId])
  @@index([category, occurredAt(sort: Desc)])
}
```

- [ ] Add `activityEvents OrderActivityEvent[]` to `SubscriptionOrder`.
- [ ] Write SQL that exactly matches the Prisma model and enum, including foreign key and indexes.
- [ ] Run:

```powershell
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api test -- test/order-activity-schema.spec.ts
```

- [ ] Confirm validation, generation, and the schema test pass.
- [ ] Commit this task:

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260728190000_add_order_activity_event/migration.sql apps/api/test/order-activity-schema.spec.ts
git commit -m "feat: add order activity projection schema"
```

---

## Task 2: Implement Idempotent Activity Recording

**Files:**
- Create: `apps/api/src/order/order-activity.types.ts`
- Create: `apps/api/src/order/order-activity.service.ts`
- Create: `apps/api/src/order/order-activity.module.ts`
- Modify: `apps/api/src/order/order.module.ts`
- Create: `apps/api/test/order-activity.spec.ts`

- [ ] Define the write contract:

```ts
export type RecordOrderActivityInput = {
  orderId: string;
  category: OrderWorkspaceCategory;
  eventType: string;
  title: string;
  summary?: string;
  sourceType: string;
  sourceId: string;
  actorType?: string;
  actorId?: string;
  actorDisplay?: string;
  occurredAt: Date;
  targetTab: OrderWorkspaceTabKey;
  targetRecordId?: string;
  idempotencyKey: string;
  metadata?: Record<string, string | number | boolean | null>;
};
```

- [ ] Add tests proving repeated writes with the same idempotency key create one row, concurrent duplicate attempts converge, and a changed event with a new key appends rather than updates history.
- [ ] Add tests rejecting secrets or raw provider payload-shaped metadata keys such as `objectKey`, `providerResponse`, `idCardNo`, and `paymentCredential`.
- [ ] Run and confirm the tests fail before implementation:

```powershell
pnpm --filter @subscription-saas/api test -- test/order-activity.spec.ts
```

- [ ] Implement `OrderActivityService.record(input)` with `upsert` on `idempotencyKey` and an empty update block so historical facts cannot be rewritten.
- [ ] Add a metadata allowlist/denylist guard and bound all string lengths before persistence.
- [ ] Create a standalone `OrderActivityModule` that imports only the Prisma dependency, provides `OrderActivityService`, and exports it. Import this module into `OrderModule`; domain modules will import the standalone module and avoid a circular dependency on `OrderModule`.
- [ ] Re-run the tests and confirm they pass.
- [ ] Commit this task:

```powershell
git add apps/api/src/order/order-activity.types.ts apps/api/src/order/order-activity.service.ts apps/api/src/order/order-activity.module.ts apps/api/src/order/order.module.ts apps/api/test/order-activity.spec.ts
git commit -m "feat: record idempotent order milestones"
```

---

## Task 3: Emit Milestones from Existing Domain Transactions

**Files:**
- Modify: `apps/api/src/order/order.service.ts`
- Modify: `apps/api/src/order/order.module.ts`
- Modify: `apps/api/src/handover-work-order/stage2-handover-workflow.service.ts`
- Modify: `apps/api/src/handover-work-order/stage2-handover-esign.service.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.module.ts`
- Modify: `apps/api/src/esign/esign.service.ts`
- Modify: `apps/api/src/esign/fadada/fadada-signed-artifact.service.ts`
- Modify: `apps/api/src/esign/esign.module.ts`
- Modify: `apps/api/src/finance/finance.service.ts`
- Modify: `apps/api/src/finance/finance.module.ts`
- Modify: `apps/api/src/service-case/service-case.service.ts`
- Modify: `apps/api/src/service-case/service-case.module.ts`
- Test: `apps/api/test/order-activity.spec.ts`
- Test: `apps/api/test/stage2-handover-esign-lifecycle.spec.ts`

- [ ] Add transaction-level tests for these normalized event types:

```text
ORDER_CREATED
CONTRACT_CREATED
CONTRACT_SIGNING_STARTED
CONTRACT_SIGNED
HANDOVER_CUSTOMER_CONFIRMED
HANDOVER_PDF_GENERATED
HANDOVER_SIGNING_STARTED
HANDOVER_CUSTOMER_SIGNED
HANDOVER_PLATFORM_SIGNED
HANDOVER_ARCHIVED
ENTITLEMENT_ACTIVATED
ENTITLEMENT_RECONCILED
SERVICE_CASE_CREATED
SERVICE_CASE_STATUS_CHANGED
PAYMENT_RECORDED
PAYMENT_RECONCILED
REFUND_COMPLETED
DEPOSIT_SETTLED
ORDER_CHANGE_SUBMITTED
ORDER_CHANGE_APPROVED
ORDER_CHANGE_APPLIED
```

- [ ] Use deterministic keys in the form `<sourceType>:<sourceId>:<eventType>:<stableVersion>`. Use the source row version or terminal timestamp when the same event type can legitimately recur.
- [ ] Confirm the tests fail because no projection rows are emitted.
- [ ] Import `OrderActivityModule` into `OrderModule`, `HandoverWorkOrderModule`, `ESignModule`, `FinanceModule`, and `ServiceCaseModule`.
- [ ] Inject `OrderActivityService` into each listed domain service and record the milestone inside the same database transaction when one exists. Entitlement milestones are emitted by `OrderService`, which owns the current entitlement mutations.
- [ ] For provider callbacks and archive retries, rely on the idempotency key so repeated callbacks do not duplicate events.
- [ ] For Stage 2, emit `HANDOVER_PLATFORM_SIGNED` when platform signing completes and emit `HANDOVER_ARCHIVED` only when the typed handover archive tuple is complete.
- [ ] Do not emit business milestones from read endpoints, polling endpoints, or page refreshes.
- [ ] Re-run:

```powershell
pnpm --filter @subscription-saas/api test -- test/order-activity.spec.ts test/stage2-handover-esign-lifecycle.spec.ts
```

- [ ] Commit the three domain groups separately with these commit subjects:

```text
feat: project contract and order milestones
feat: project handover signing milestones
feat: project entitlement service and finance milestones
```

---

## Task 4: Expose and Render the Activity Timeline

**Files:**
- Modify: `apps/api/src/order/order.controller.ts`
- Modify: `apps/api/src/order/order-workspace.service.ts`
- Modify: `apps/api/test/order-workspace.spec.ts`
- Modify: `apps/web/src/lib/admin-order-workspace.ts`
- Modify: `apps/web/src/app/orders/[id]/page.tsx`
- Modify: `apps/web/test/admin-order-workspace.spec.ts`

- [ ] Add API tests for:
  - descending `occurredAt` order;
  - page/page-size pagination;
  - category filtering;
  - permission/sales-scope denial;
  - safe DTO metadata;
  - stable source links only for sources the current user may view.
- [ ] Implement:

```http
GET /orders/:id/workspace/activity?category=HANDOVER&page=1&pageSize=30
```

Response:

```ts
type OrderWorkspaceActivityPage = {
  items: Array<{
    id: string;
    category: OrderWorkspaceCategory;
    eventType: string;
    title: string;
    summary: string | null;
    occurredAt: string;
    actorLabel: string | null;
    source: { type: string; id: string };
    target: {
      tab: OrderWorkspaceTabKey;
      recordId: string | null;
      href: string;
    };
  }>;
  page: number;
  pageSize: number;
  total: number;
};
```

- [ ] Validate `page >= 1` and `1 <= pageSize <= 100`. Sort by `occurredAt DESC`, then `id DESC`, and return a total count for stable paginated `Load more`.
- [ ] Run the API test and confirm it fails before implementation.
- [ ] Add Web tests for initial activity loading, page-based load-more pagination, category filter, and empty state.
- [ ] Populate the workspace summary's bounded `recentActivity` preview from the latest permitted projection rows.
- [ ] In the overview tab, render the cross-domain timeline grouped by date with category filters and paginated `Load more`. Keep the change/history tab limited to order-change transactions and immutable before/after snapshots.
- [ ] Keep operational audit records out of this timeline.
- [ ] Re-run the focused API and Web tests and confirm they pass.
- [ ] Commit this task:

```powershell
git add apps/api/src/order/order.controller.ts apps/api/src/order/order-workspace.service.ts apps/api/test/order-workspace.spec.ts apps/web/src/lib/admin-order-workspace.ts "apps/web/src/app/orders/[id]/page.tsx" apps/web/test/admin-order-workspace.spec.ts
git commit -m "feat: add order workspace activity timeline"
```

---

## Task 5: Backfill Verifiable Historical Milestones

**Files:**
- Create: `scripts/order-activity-backfill-core.mjs`
- Create: `scripts/order-activity-backfill.mjs`
- Create: `scripts/order-activity-backfill-core.test.mjs`
- Modify: `package.json`

- [ ] Add pure core tests mapping source rows to deterministic events and skipping ambiguous states.
- [ ] Cover reruns, duplicate source rows, missing timestamps, typed Stage 2 archive completion, and generic e-sign artifacts that must not imply Stage 2 archival.
- [ ] Add scripts:

```json
"order-activity:backfill:test": "node --test scripts/order-activity-backfill-core.test.mjs",
"order-activity:backfill:dry-run": "node scripts/order-activity-backfill.mjs --dry-run",
"order-activity:backfill:apply": "node scripts/order-activity-backfill.mjs --apply"
```

- [ ] Run the core test and confirm it fails before implementation:

```powershell
pnpm order-activity:backfill:test
```

- [ ] Implement source readers for only these verifiable records: orders, contracts/e-sign terminal transitions, typed handover statuses, entitlement activation/reconciliation, service-case creation/status timestamps, finance terminal records, and order changes.
- [ ] Print counts by category, skipped ambiguous rows, duplicate idempotency keys, and proposed writes in dry-run mode.
- [ ] Require explicit `--apply`; use idempotent inserts and bounded batches.
- [ ] Re-run the core test and a local dry run.
- [ ] Commit this task:

```powershell
git add scripts/order-activity-backfill-core.mjs scripts/order-activity-backfill.mjs scripts/order-activity-backfill-core.test.mjs package.json
git commit -m "feat: add order activity backfill"
```

---

## Task 6: Add the Related-Document Index

**Files:**
- Create: `apps/api/src/order/order-document-index.service.ts`
- Modify: `apps/api/src/order/order.controller.ts`
- Modify: `apps/api/src/order/order.module.ts`
- Create: `apps/api/test/order-document-index.spec.ts`
- Create: `apps/web/src/components/order-workspace/related-documents-drawer.tsx`
- Modify: `apps/web/src/app/orders/[id]/page.tsx`
- Create: `apps/web/test/order-related-documents.spec.ts`

- [ ] Define the safe response:

```ts
type OrderRelatedDocument = {
  id: string;
  category: "CONTRACT" | "HANDOVER" | "FINANCE" | "SERVICE" | "CHANGE";
  title: string;
  documentNo: string | null;
  lifecycle: "SOURCE" | "SIGNED" | "ARCHIVED" | "RECEIPT" | "EVIDENCE";
  createdAt: string;
  previewUrl: string | null;
  downloadUrl: string | null;
};
```

- [ ] Add API tests proving the index includes Stage 1 contracts, authoritative Stage 2 source/signed artifacts, finance receipts, and service/change attachments only when the current user has access.
- [ ] Add tests proving object keys and provider payloads never appear, and generic Stage 2 task artifacts cannot be labeled archived.
- [ ] Run the test and confirm it fails before implementation:

```powershell
pnpm --filter @subscription-saas/api test -- test/order-document-index.spec.ts
```

- [ ] Implement `GET /orders/:id/workspace/documents?category=<optional>` as a read-only aggregator. Generate preview/download URLs through existing typed endpoints; never expose storage paths.
- [ ] Build a compact related-documents drawer with category filter, title, document number, lifecycle, date, preview icon, and download icon.
- [ ] Add contextual entry points in contract, handover, finance, service, and change tabs. Do not put a global document dump above the tabs.
- [ ] Add Web tests for category filtering, signed-vs-source Stage 2 labels, empty state, and permission-hidden actions.
- [ ] Re-run API and Web tests and confirm they pass.
- [ ] Commit this task:

```powershell
git add apps/api/src/order/order-document-index.service.ts apps/api/src/order/order.controller.ts apps/api/src/order/order.module.ts apps/api/test/order-document-index.spec.ts apps/web/src/components/order-workspace/related-documents-drawer.tsx "apps/web/src/app/orders/[id]/page.tsx" apps/web/test/order-related-documents.spec.ts
git commit -m "feat: add order related document index"
```

---

## Task 7: Deepen the In-Use Matters Tab

**Files:**
- Modify: `apps/api/src/order/order-workspace.service.ts`
- Modify: `apps/api/test/order-workspace.spec.ts`
- Modify: `apps/web/src/app/orders/[id]/page.tsx`
- Modify: `apps/web/test/admin-order-workspace.spec.ts`

- [ ] Add summary tests for order-filtered service cases grouped into actionable, waiting-external, and completed counts.
- [ ] Include currently modeled insurance/maintenance/incident records only through their existing typed modules and permissions.
- [ ] Run the tests and confirm the initial service-tab implementation fails the new grouped-summary assertions.
- [ ] Extend the service guide resolver to point to the highest-priority actionable service record.
- [ ] Render a compact summary followed by the existing paginated service-case list filtered by `orderId`.
- [ ] Add direct links to existing service-case details and contextual related documents.
- [ ] Keep future unmodeled business types out of the UI until a typed source exists; do not create empty decorative categories.
- [ ] Re-run focused tests and confirm they pass.
- [ ] Commit this task:

```powershell
git add apps/api/src/order/order-workspace.service.ts apps/api/test/order-workspace.spec.ts "apps/web/src/app/orders/[id]/page.tsx" apps/web/test/admin-order-workspace.spec.ts
git commit -m "feat: deepen order in-use matters"
```

---

## Task 8: Deploy Migration, Backfill, and Verify

**Files:**
- Verify only.

- [ ] Run the complete affected test set:

```powershell
pnpm --filter @subscription-saas/api test -- test/order-activity-schema.spec.ts test/order-activity.spec.ts test/order-workspace.spec.ts test/order-document-index.spec.ts test/stage2-handover-esign-lifecycle.spec.ts
pnpm --filter @subscription-saas/web test -- test/admin-order-workspace.spec.ts test/order-related-documents.spec.ts
pnpm order-activity:backfill:test
```

- [ ] Run:

```powershell
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/api build
pnpm --filter @subscription-saas/web build
```

- [ ] Push the branch, open a PR, obtain review, and merge after checks pass.
- [ ] Build and deploy the API image containing both the migration and application code.
- [ ] Run `pnpm prisma:migrate:deploy` through the image's direct Prisma command path used by the deployment runbook; do not invoke a workspace command that reinstalls dependencies inside the running container.
- [ ] Confirm `pnpm prisma:migrate:status` reports no pending migration.
- [ ] Run the backfill dry-run and retain its category/skip counts for review.
- [ ] Run the backfill apply only after dry-run review, then rerun dry-run and confirm zero proposed writes.
- [ ] Verify the known Stage 2 order shows distinct signature-completed and archive-completed milestones.
- [ ] Verify timeline pagination, related-document permissions, Stage 2 signed/source labeling, service-case drill-down, and browser refresh/back navigation.
