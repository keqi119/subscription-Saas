# Order Workspace Design

Date: 2026-07-28

## Status

Product direction and detailed design confirmed in review. This document is the implementation baseline pending final written-spec review.

## Background

The current Admin order detail page is a long vertical collection of module panels. Its header-level `Generate Contract` and `View Contract` actions are specific to the Stage 1 subscription contract even though an order can already have a Stage 2 vehicle handover agreement and may later have vehicle-swap, return-inspection, entitlement-specific, renewal, or termination agreements.

The page must become an order workspace: a high-density operational surface that organizes existing system capabilities around one order without creating a second source of business truth.

## Goals

1. Show the operator the current next action and its blocking or non-blocking context.
2. Organize order data by stable business transaction domains instead of implementation stage or component.
3. Keep the first viewport and each tab dense enough for repeated Admin use.
4. Support repeated transactions such as multiple swaps, handovers, bills, claims, and agreements without making the page longer.
5. Preserve each domain module as the authoritative source for its data and write operations.
6. Provide a user-readable cross-domain order activity timeline.
7. Make all document links reflect the authoritative signing and archive lifecycle.

## Non-goals

- Replacing contract, handover, entitlement, finance, service-case, or order-change domain services.
- Introducing a generic endpoint that mutates arbitrary order transactions.
- Rendering raw audit logs as the operator-facing timeline.
- Moving all documents into one business workflow.
- Changing the already accepted Stage 2 rule that signature completion, rather than archive completion, gates Admin delivery confirmation.

## Page Structure

### Header

The header contains:

- Back navigation.
- Order number and order status.
- Compact customer and current-vehicle context.
- Refresh.
- An order-level overflow menu for actions that do not belong to one transaction domain.

The Stage 1-specific `Generate Contract` and `View Contract` buttons are removed from the header. Contract generation and viewing move into the relevant transaction tab and top guidance.

### Current Transaction Guidance

The guidance area appears immediately below the header and follows the existing Admin reporting-page visual language.

It covers all six actionable transaction categories in a stable order:

1. Main contract and subscription package.
2. Vehicle handover.
3. Subscription entitlements.
4. In-use matters.
5. Finance and reconciliation.
6. Order change.

Each item can have these normalized states:

- `BLOCKED`
- `ACTION_REQUIRED`
- `FAILED`
- `PROCESSING`
- `WAITING_EXTERNAL`
- `READY`
- `COMPLETED`
- `NOT_STARTED`
- `UNAVAILABLE`

Priority order is:

`BLOCKED` -> `ACTION_REQUIRED` -> `FAILED` -> `PROCESSING` -> `WAITING_EXTERNAL` -> `READY` -> `COMPLETED` -> `NOT_STARTED`.

The highest-priority item is visually emphasized and supplies the primary next action. Clicking an item switches to the target tab and focuses the target record. If several records exist in one category, the item shows the highest-priority record and an additional-count indicator.

The target is represented in the URL:

```text
/orders/:orderId?tab=<tabKey>&focus=<recordId>
```

When no action is pending, the page explicitly states that order fulfillment is operating normally.

### Transaction Tabs

Use compact labels in the tab bar and full labels inside each panel:

| Tab key | Compact label | Scope |
| --- | --- | --- |
| `overview` | Basic | Current effective order state, customer, current vehicle, period, source records, review results, and cross-domain activity timeline |
| `contract` | Contract / Package | Stage 1 main contract, order-level amendments, e-sign lifecycle, and immutable signed package snapshots |
| `handover` | Vehicle Handover | Initial delivery, each vehicle-swap handover, return inspection, field evidence, objections, handover e-sign, delivery, and recovery actions |
| `entitlement` | Entitlements | Entitlement accounts, grants, renewal, consumption, freezing, expiration, and entitlement-specific agreements |
| `service` | In-use Matters | Service cases, maintenance, roadside assistance, incidents, insurance claims, violations, complaints, and related materials |
| `finance` | Finance | Receivables, payments, deposits, refunds, invoices, reconciliation, overdue items, and collections |
| `change` | Change History | Vehicle, package, and term changes; renewal; early termination; approval; execution; and immutable before/after snapshots |

Tabs are permission-aware. A user without view permission for a domain does not receive or see its sensitive values.

## Tab Depth Pattern

Every transaction tab uses the same three layers:

1. Summary: key status, counts, amounts, pending actions, and anomalies.
2. Records: a paginated and filterable table of transaction occurrences.
3. Detail: a row expansion or drawer containing workflow steps, attachments, documents, granular event history, and authorized actions.

Repeated occurrences add table rows instead of new page sections. The initial delivery, the third vehicle swap, and the final return inspection are separate records with their own identity and history.

Tabs load lazily. Opening an order loads the header, guidance, tab badges, and a short activity preview. Activating a tab loads that domain's data.

## Cross-domain Rules

Cross-domain business events are split by ownership and connected with references:

- A vehicle-swap request, approval, and before/after plan snapshot belong to Change History.
- Old-vehicle return and new-vehicle delivery belong to Vehicle Handover.
- Swap-entitlement consumption belongs to Entitlements.
- Price differences, refunds, and new receivables belong to Finance.
- Service materials and claim evidence belong to In-use Matters.

The workspace links related records but never duplicates their authoritative state.

## Document Placement

Documents follow their business transaction:

- Stage 1 main contract and package attachments: Contract / Package.
- Delivery, swap, and return handover confirmations: Vehicle Handover.
- Charging, washing, swap, or other entitlement-specific agreements: Entitlements.
- Claims and incident responsibility documents: In-use Matters.
- Change or termination supplements: Change History.
- Billing, refund, invoice, and reconciliation evidence: Finance.

An `All Related Documents` drawer provides a cross-tab index for search, preview, and download. It does not contain initiation, approval, signing, retry, or other business workflow actions.

### Stage 2 Document Lifecycle

- The unsigned source PDF remains immutable evidence and retains its hash binding.
- Before authoritative signed-file archive completes, the source link is explicitly labeled `View unsigned source`.
- After typed Stage 2 archive completes, the primary order-page download switches to the authoritative signed PDF.
- A generic e-sign task object key cannot make Stage 2 appear archived.
- Signature completion enables Admin delivery confirmation even if archive is pending or failed.
- Archive failure remains visible and recoverable but does not falsely block delivery.

## Stage 2 Vehicle Handover Placement

The current Stage 2 area becomes an occurrence within Vehicle Handover.

The records table shows:

- Transaction type.
- Vehicle.
- Field operator.
- Evidence completion.
- Customer-review state.
- E-sign state.
- Business confirmation state.
- Contextual actions.

Expanding a record shows:

- Field evidence and on-site facts.
- Customer confirmation or objection.
- Customer signature and platform seal.
- Typed archive status.
- Signed or unsigned document action according to the lifecycle rules.
- Admin fallback, recovery, void, reassignment, and delivery confirmation when authorized.

Stage 2 operational actions remain in this tab. The cross-tab document drawer only indexes its source and signed artifacts.

## Workspace Read Model

The order workspace is an aggregation layer, not a new business domain.

### Summary endpoint

```text
GET /orders/:id/workspace/summary
```

It returns:

- Safe order header context.
- Transaction guidance.
- Permission-filtered tab badges.
- A recent activity preview.
- `asOf` for freshness display and refresh decisions.

A guidance item has:

```text
category
state
priority
actionCode
reasonCode
targetTab
targetRecordId
blocking
updatedAt
```

Domain contributors calculate their own state and blocking semantics. The workspace service normalizes and sorts their results. The frontend does not infer business readiness from unrelated status fields.

### Activity endpoint

```text
GET /orders/:id/workspace/activity
  ?category=<optional>
  &page=<n>
  &pageSize=<n>
```

### Domain data

Each tab reuses or extends typed domain endpoints. Write operations remain on their existing typed endpoints with their existing permission and invariant checks.

## Order Activity Projection

Add a user-readable `OrderActivityEvent` projection rather than treating `AuditLog` as a UI timeline.

Recommended fields:

```text
id
orderId
category
eventType
sourceType
sourceId
title
summary
actorType
actorId
actorDisplay
occurredAt
targetTab
targetRecordId
idempotencyKey
metadata
createdAt
```

`idempotencyKey` is unique so callback, retry, and reconciliation paths cannot duplicate one milestone.

The three history surfaces remain distinct:

- Order activity timeline: operator-readable cross-domain milestones.
- Transaction detail history: granular workflow events for one record.
- Audit log: compliance-grade before/after snapshots and request context.

The Basic tab initially shows the latest milestones, grouped by date, with category filters and paginated `Load more`.

Historical orders can be backfilled from authoritative timestamps and existing event records. Events that cannot be inferred reliably are not fabricated.

## Permissions and Data Safety

- The summary and tab data are filtered by domain view permissions.
- A user with view but not action permission sees status and `View`, not an enabled action.
- All write endpoints recheck permission and business invariants server-side.
- Financial values, identity data, signed files, and evidence keep their existing specialized permissions.
- Provider URLs, provider task identifiers, storage buckets, object keys, raw callback payloads, and unsafe provider errors never enter workspace responses.
- Safe reason codes, not raw provider text, drive operator messages.

## Failure and Consistency Rules

- One tab failing to load does not blank the rest of the workspace.
- A failed tab has a local retry control.
- If a domain guidance contributor fails, its item becomes `UNAVAILABLE` and exposes no action.
- The workspace fails closed for action availability but can continue showing independently verified domains.
- After a mutation, refresh the summary and active tab instead of reloading every domain.
- Multiple active records use deterministic priority, then oldest required action, then record ID as a stable tie-breaker.
- Non-blocking warnings remain visually distinct from blocking errors.

## Existing UI Migration

| Current order-page area | Target |
| --- | --- |
| Order, customer, vehicle facts and review status | Basic |
| Original quote and signed package snapshot | Contract / Package |
| Later package, vehicle, or term before/after snapshots | Change History |
| Header contract buttons and contract info | Contract / Package |
| Delivery preparation and Stage 2 handover | Vehicle Handover |
| Vehicle return and return inspection | Vehicle Handover |
| Entitlement grants and usages | Entitlements |
| Bills, payments, deposit settlement, overdue and collection | Finance |
| Service cases, maintenance, incidents, claims, violations | In-use Matters |
| Active change alert, change actions, change snapshots | Change History and top guidance |

Existing modals can be retained initially and opened from the new tab context. Their business logic must not be duplicated during the layout migration.

## Contract Management List Improvement

The contract management list receives two independent server-side filters:

- Contract number, fuzzy `contains`.
- Order number, fuzzy `contains`.

When both are provided, they use `AND`. Inputs are trimmed and bounded. Empty filters restore the full authorized list.

The list adds a `Contract title` column using `Contract.contractTitle`, with `-` only for legacy or invalid missing data.

Frontend-only filtering is not permitted because it becomes incomplete once pagination or larger datasets are introduced.

## Delivery Phases

### Phase 1: Workspace shell and current domains

- Introduce summary and guidance contracts.
- Move current panels into the seven-tab workspace.
- Remove Stage 1-specific header actions.
- Preserve current typed actions and modals.
- Add URL tab/focus state and lazy loading.
- Add contract list filters and title column.

### Phase 2: Activity projection

- Add `OrderActivityEvent`.
- Emit idempotent milestones from current domains.
- Backfill reliable historical milestones.
- Add activity filtering and deep links.

### Phase 3: In-use matters and document index

- Aggregate service cases, maintenance, incidents, claims, and violations.
- Add the cross-tab related-document drawer.
- Expand domain contributors as new transaction types are introduced.

## Acceptance Criteria

1. The order page no longer presents Stage 1-specific contract navigation in the global header.
2. The first viewport shows a concise next-action guide and the transaction tabs.
3. The seven confirmed transaction categories are available subject to permissions.
4. Current Stage 2 capabilities remain reachable from Vehicle Handover.
5. Repeated transactions are records, not additional vertical page sections.
6. Selecting a guidance item opens the correct tab and focused record, including after refresh.
7. Tab failures are isolated and independently retryable.
8. The Basic timeline shows safe milestones and does not expose raw audit or provider data.
9. Signed Stage 2 documents only become the primary download after authoritative typed archive.
10. Delivery confirmation remains enabled after required signatures complete even when archive is incomplete.
11. Contract management supports server-side fuzzy contract-number and order-number filters and displays contract title.
12. Existing domain permission checks and data ownership remain intact.
