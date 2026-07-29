# Six-Month Subscription Automation Design

Date: 2026-07-29

Status: Approved design baseline

## Context

The current system can complete a subscription order with substantial operator
involvement. It already has customer applications, product and vehicle review,
orders, Stage 1 and Stage 2 signing, bills, WeChat JSAPI payment, delivery,
monthly entitlements, return handling, service cases, and operational reports.

The next six-month product target is not multi-tenant platformization. It is a
single-operator subscription business that can move its normal order flow
automatically from A/B-line application through signing, payment, delivery,
notifications, recurring billing, and contract completion.

Accounting posting and real refund execution remain manual. Collection and
write-off of customer funds must be automated. Future asset-company access must
be possible without turning the current back office into a multi-tenant system
inside this delivery window.

## Goals

1. Automate the normal A/B-line order-to-delivery flow while retaining explicit
   human decisions for final-plan approval, final vehicle allocation, and
   delivery-evidence acceptance.
2. Automate bill generation, customer payment, delegated recurring collection,
   payment callback processing, and receivable write-off.
3. Provide durable workflow execution with idempotency, retries, timeouts,
   operator takeover, and end-to-end auditability.
4. Support in-term vehicle swaps, multi-model vehicle packages, early
   termination, contract extension, and entitlement purchases through explicit
   change orders.
5. Add customer-level points and purchasable mileage, charging, and vehicle-swap
   entitlements.
6. Preserve the single-operator architecture while introducing an explicit
   asset-owner boundary for a possible future asset-company SaaS entry.

## Non-Goals

- General-ledger posting, accounting vouchers, tax accounting, or automated
  financial close.
- Automated approval or execution of customer refunds.
- Full multi-tenancy or an asset-company user portal in the six-month scope.
- Asset-company control over platform products, customer orders, vehicle
  allocation, or fulfillment.
- Automated mileage OCR, vehicle telematics ingestion, or charging-partner API
  integration.
- Payment channels other than WeChat Pay. The internal boundary remains
  provider-independent so another provider can be added later.

## Architecture Decision

The approved approach is a lightweight orchestration kernel inside the existing
application and database.

Directly chaining the existing services would be quicker initially, but it
would make cross-domain retries, idempotency, and operator recovery harder.
Splitting the system into multi-tenant microservices would add more risk than
the six-month target can justify.

The orchestration kernel decides which step is next but does not own or mutate
domain facts directly. Orders, contracts, receivables, payments, deliveries,
vehicles, leases, entitlements, and notifications remain owned by their domain
services.

The kernel consists of:

- a durable workflow instance for each business journey;
- durable workflow steps with wait, ready, running, completed, failed, and
  cancelled states;
- human tasks for the three approved operator decisions;
- immutable business events;
- durable execution jobs with stable idempotency keys;
- exception cases with ownership, service level, and recovery actions;
- a transactional outbox used to publish work only after the owning domain
  transaction commits.

## Order-To-Delivery Workflow

Both A-line and B-line applications converge on the same subscription workflow
after their intake-specific data has been collected.

The normal journey is:

1. Receive the A/B-line application and consolidate materials.
2. Run deterministic completeness and policy checks.
3. Create a human task for final-plan approval.
4. Notify the customer and wait for final-plan confirmation.
5. Create a human task for final vehicle allocation.
6. Automatically create the quote, order, contract, and Stage 1 signing task.
7. Wait for trusted signing callbacks and complete the signed archive.
8. Automatically create initial receivables and the payment/mandate flow.
9. Process payment callbacks and write off the receivables.
10. Automatically create the delivery work order.
11. Create a human task for delivery-evidence acceptance.
12. Complete Stage 2 signing and signed-archive processing.
13. Activate the order, current vehicle, and lease from one authoritative
    activation operation.
14. Start recurring billing, delegated collection, entitlement, and
    notification schedules.

Customer confirmation, customer signing, customer payment, and customer
handover actions are durable wait states. They are external actions, not
operator approval gates. Reminder and timeout jobs operate on those wait states
without keeping a process or request open.

The workflow can be cancelled or compensated at defined boundaries. Completed
legal, payment, and audit facts are never deleted or rolled back.

## Activation And Financial Truth

Receivable bills, payment transactions, and payment write-offs are the only
authoritative evidence that required funds were received.

Delivery readiness must not use operator checkboxes for deposit or first-month
payment. The activation operation must verify the required paid/write-off facts
and then synchronize:

- subscription order status to `ACTIVE`;
- allocated vehicle status to `LEASED`;
- lease status to `ACTIVE`;
- the workflow step to completed.

The operation must either complete all mutable activation facts in its domain
transaction or leave the order ready for safe retry. A workflow may not report
successful activation while the order, vehicle, and lease disagree.

## Recurring Billing And Delegated Collection

Existing receivable, payment-order, payment-record, and write-off models remain
the financial source of truth. Automation adds three explicit concepts:

- `BillingSchedule`, which determines when the next receivable is generated;
- `PaymentMandate`, which records WeChat delegated-payment authorization,
  validity, revocation, and customer ownership;
- `DebitAttempt`, which records every delegated collection request, provider
  result, idempotency key, and retry decision.

The default schedule is:

| Time | Action |
| --- | --- |
| Due date minus 3 days | Generate or confirm the bill and send the bill/debit notice |
| Due date | Submit the first delegated debit |
| Due date plus 1 day | Retry an unpaid bill |
| Due date plus 3 days | Submit the final automatic retry and send a critical SMS |
| Due date plus 5 days | Mark the bill overdue and open a collection task |

The first customer payment establishes the WeChat authorization needed for
later monthly delegated collection. Customers can still pay an open bill
actively. An active payment that settles the bill cancels pending debit
attempts.

Each provider transaction can be applied once. Duplicate, late, and reordered
callbacks return idempotent results. A bill can receive money from active and
delegated payments, but total write-off cannot exceed the receivable amount.

A failed debit does not automatically suspend the order, vehicle, or lease.
After the grace period, operations decide whether to restrict new optional
benefits or start a termination process.

Automated payment covers collection and business write-off only. Accounting
posting remains manual. Refund calculation, approval, and provider execution
remain manual; the system records the proposed amount, freezes any amount
awaiting refund, and records the final external result.

## Notification Strategy

Customer notifications use:

- WeChat Official Account messages as the primary channel;
- Portal inbox messages as the durable customer record;
- SMS only for time-sensitive or high-priority conditions such as signing
  expiry, repeated collection failure, overdue bills, and delivery changes.

Operator tasks and automation failures appear in the back-office task and
exception workbench.

Every notification stores its event, template version, destination, channel,
attempt count, send result, and related business reference. Notification
failure does not roll back the domain transaction that caused the notification.

## Subscription Change Center

In-term changes use an explicit `SubscriptionChangeOrder`. The original order,
contract, price snapshot, and historical bills are not overwritten.

A change order records:

- type and reason;
- customer or operator initiation;
- effective date;
- product, pricing, and policy snapshots;
- quote and settlement calculation;
- points and cash allocation;
- customer confirmation;
- required amendment and signing state;
- payment state;
- execution references and final result.

The general lifecycle is:

`DRAFT -> QUOTED -> CUSTOMER_CONFIRMED -> SIGNING_OR_PAYMENT -> SCHEDULED ->
EXECUTING -> COMPLETED`

Individual change types skip steps that do not apply. Cancellation, failure,
and operator takeover are explicit states rather than edits to completed
history.

### Vehicle-Package Model

A versioned vehicle package defines:

- the set of models eligible for allocation and switching;
- the expected allocation-time weight for each model;
- the weighted base subscription price;
- included vehicle-swap entitlement count;
- minimum commitment period;
- early-termination penalty rate;
- purchasable entitlements and eligibility;
- effective dates and a stable product version.

The base price is a weighted average:

`sum(model reference price * expected allocation-time weight) / sum(weights)`

The signed vehicle-package price remains fixed during the original contract
term. A normal swap inside the package neither reprices the monthly subscription
nor prorates actual model usage.

### Vehicle Swaps

A customer-requested in-package swap:

1. verifies package eligibility and available swap entitlement;
2. reserves one entitlement without consuming it;
3. creates a human task for final replacement-vehicle allocation;
4. records return evidence for the old vehicle and delivery evidence for the
   replacement;
5. creates a human task for delivery-evidence acceptance;
6. switches the order's current vehicle only after the replacement handover
   succeeds;
7. consumes the reserved entitlement on final completion.

A cancelled or failed swap releases the entitlement reservation.

An operational protection swap caused by fault, repair, accident, or recall
uses the same vehicle and evidence workflow but never consumes a customer
entitlement. It is tagged for vehicle-quality and operational-cost reporting.

An out-of-package request creates a price difference quote. Customer points can
reduce that difference under configured rules, and any remainder becomes a
receivable that must be paid before allocation proceeds.

### Early Termination

The product version stores a minimum commitment period and an
early-termination penalty rate.

After the minimum commitment is reached, early termination has no penalty and
settles only actual charges. Before the minimum commitment is reached:

`penalty = remaining committed subscription value * penalty rate`

Remaining committed subscription value includes only non-cancellable fixed
subscription fees between the effective termination date and the original
contract end. Incurred charges are settled separately. Cancellable entitlement
purchases are excluded.

The system produces a settlement preview, obtains customer confirmation,
creates the termination amendment, stops future bills and entitlement renewal
at the effective time, and starts return handling. Finance performs any real
refund manually.

### Contract Extension

An extension is a new continuous contract segment rather than an edit to the
original term.

The default quote uses the effective product version at the time of the
extension request. An authorized operator can approve the original price or a
renewal discount. After customer confirmation and amendment signing, the system
extends billing, delegated collection, entitlement, insurance-check, and
notification schedules. A failed extension leaves the original contract end
unchanged.

## Entitlement And Points Model

The initial entitlement catalog contains:

| Entitlement | Unit | Reference Price | Purchase Type |
| --- | ---: | ---: | --- |
| Mileage package | 1,000 km | CNY 800 | One-time or monthly recurring |
| Charging package | 100 kWh | CNY 60 | One-time or monthly recurring |
| Vehicle-swap entitlement | 1 swap | CNY 1,000 | One-time only |

Prices are versioned product configuration, not hard-coded constants.

Monthly included and monthly purchased entitlements reset each billing period
and do not roll over. One-time mileage and charging packages remain valid until
the current subscription contract ends. Entitlement lots are consumed in
earliest-expiry order.

One-time purchases become active after successful payment. Monthly recurring
add-ons require customer confirmation and join later monthly bills. A vehicle
swap consumes an entitlement only after the swap completes.

When confirmed usage exceeds all included and purchased entitlement balances,
the excess is charged linearly rather than rounded up to another package:

- mileage overage is CNY 0.80 per km;
- charging overage is CNY 0.60 per kWh.

The overage becomes an adjustment on the next-period bill. The customer may
apply eligible points, and the remaining amount is collected through active
payment or delegated collection.

Customer points use a customer-level, append-only ledger. Each grant has a
source, effective time, expiry, applicable products, usage scope, and optional
redemption cap. Points are not cash, cannot be withdrawn, and do not become a
payment transaction. A cancellation or failed fulfillment reverses a points
consumption through a new ledger entry.

For a special request, the system calculates the price difference, applies
eligible points, and creates a receivable for the remaining cash amount.

## Usage Evidence And Manual Entry

Mileage and charging usage are entered by operators during the six-month scope.

For mileage:

- the customer uploads an odometer photo as source evidence;
- an operator inspects the image and manually enters the cumulative reading;
- the system calculates usage from the previous confirmed cumulative reading.

For charging:

- an operator uploads or references the partner's monthly report;
- the operator manually enters the confirmed kWh for the customer, vehicle, and
  billing period.

Every entry stores the period, vehicle, customer, operator, source evidence, and
confirmation time. Existing confirmed records are not overwritten. Corrections
use reversal and replacement records with a reason and audit trail.

Missing readings are not estimated. The system sends reminders and opens an
exception. A later cumulative reading or partner report produces a confirmed
adjustment. If the related bill is already closed, the adjustment enters the
next billing period rather than rewriting the closed period.

## Asset-Owner Boundary

The six-month system continues to have one operating entity and one back-office
permission domain. It does not add tenant-aware routing or general tenant
isolation.

It introduces:

- `AssetOwner`, representing the platform or an external asset company;
- `VehicleOwnershipPeriod`, preserving time-bounded ownership history;
- an asset-owner snapshot on allocated orders and attributable financial or
  operational facts;
- owner-based aggregation for acquisition, insurance, repair, depreciation,
  residual value, financing, revenue, and settlement analysis.

The ownership snapshot prevents a later vehicle ownership change from
reattributing historical contract economics.

Customer collection still enters the platform payment system. The system can
produce an asset-company settlement preview and statement, but accounting,
invoicing, and real settlement payment remain manual.

A future asset-company SaaS entry is limited initially to:

- its vehicle inventory and status;
- privacy-reduced order and contract summaries;
- income, cost, utilization, and residual-value analysis;
- monthly settlement statements and confirmation;
- insurance, vehicle-document, and settlement-material upload.

Asset-company users cannot edit platform products, customers, orders, vehicle
allocation, or fulfillment. Subject-level data isolation and asset-company
users are added when that portal is actually delivered, not in the current
automation program.

## Failure Handling And Operator Recovery

System failures use bounded automatic retries with backoff. Business
rejections, missing source data, conflicts, and exhausted retries create an
operator-owned exception instead of looping.

The exception workbench displays:

- blocked workflow and step;
- customer, order, bill, vehicle, and change-order references;
- prior attempts and complete error details;
- recommended actions and required permission;
- owner, deadline, and escalation state;
- audited resume, cancel, compensate, or manually-complete actions.

Cross-domain workflows use explicit compensation, such as releasing a vehicle
hold, cancelling an unexecuted payment order, or restoring a reserved
entitlement. Immutable contracts, payment facts, write-offs, points, and
entitlement ledgers are corrected only by superseding or reversal records.

## Security And Audit

- Customer actions require customer ownership checks.
- Operator actions use the existing permission model.
- Every human approval, override, workflow recovery, manual usage entry, points
  adjustment, and manual payment/refund record is audited.
- Asset-company summaries expose only the customer data required for the asset
  relationship.
- Provider credentials, mandates, callbacks, and signed documents remain
  protected server-side resources.

## Acceptance Criteria

The operational target is:

- at least 95 percent of normal orders need no operator work beyond final-plan
  approval, final vehicle allocation, and delivery-evidence acceptance;
- scheduled bills are generated on time;
- automation failures appear in the exception workbench within five minutes;
- duplicate requests and callbacks never create duplicate orders, bills,
  payment application, points, or entitlements;
- every subscription is traceable from application through order, contract,
  payment, delivery, notification, recurring operation, and return;
- service restart, callback duplication, callback reordering, and provider
  timeout result in recovery or an explicit operator-owned exception.

Required system-level scenarios are:

1. A-line and B-line normal order-to-activation flows.
2. Signing timeout, refusal, duplicate callback, and signed-archive recovery.
3. Active payment, delegated payment, failed retries, overdue transition, and
   later active settlement.
4. In-package customer swap, operational protection swap, and out-of-package
   points/cash settlement.
5. Early termination before and after the minimum commitment.
6. Contract extension at current price and approved retained/discounted price.
7. One-time and recurring entitlement purchase.
8. Mileage and charging manual entry, correction, missing data, and late
   adjustment.
9. Stage 2 evidence, signing, archive recovery, activation, return, deposit
   settlement, and vehicle re-entry.
10. Workflow recovery after worker or API restart.

Every database release must be tested against a new database and an upgraded
existing database. A migration that has been committed or applied must never be
edited; later corrections require a new additive migration.
