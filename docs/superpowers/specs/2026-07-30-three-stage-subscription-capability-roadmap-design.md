# Three-Stage Subscription Platform Capability Roadmap

Date: 2026-07-30

Status: Approved design baseline

Related functional design: [Six-Month Subscription Automation Design](./2026-07-29-six-month-subscription-automation-design.md)

## Context And Goal

The system has not entered material production operation. The implementation
goal is not to build a complete operations and finance platform in one release.
It is to strengthen three business layers incrementally while controlling the
migration cost of current offline work:

1. The business line runs normal fulfillment around the subscription contract.
2. The operations platform manages the vehicle lifecycle, capital, debt,
   revenue rights, and outbound payment.
3. Finance receives traceable operating-finance facts, statistics, and
   forecasts that prepare for later finance integration.

The roadmap is divided by closed capability rather than technical layer or
department. Every stage must create independent operating value and produce
stable facts for the next stage.

## Stage Overview

| Stage | Position | Primary users | Core result |
| --- | --- | --- | --- |
| Stage 1 | Subscription operation and operating-fact foundation | Business, operations, asset operations | Normal contract fulfillment is automated and contract cash, vehicle state, and direct cost are complete |
| Stage 2 | Asset capital, debt, revenue rights, and outbound funds | Operations, asset operations, finance | Offline financing, settlement, and daily-payment sheets become system workflows |
| Stage 3 | Operating-finance analysis and finance-integration readiness | Management, operating finance, finance | Portfolio metrics, funding forecast, asset analysis, and reconcilable accounting-source data |

Progression is gated by acceptance rather than an automatic calendar date. A
later metric or automation cannot activate while its prerequisite facts are
unreliable.

## Stage 1: Subscription Operation And Operating-Fact Foundation

Stage 1 follows the subscription contract. Apart from approved final-plan,
vehicle-allocation, and delivery-evidence decisions, overdue collection,
contract change, and exception handling, normal flow should run automatically.

### Stage 1A: Bring A New Contract Into Operation

Scope:

- A/B-line application and material consolidation;
- deterministic checks and final-plan confirmation;
- final vehicle allocation;
- quote, order, Stage 1 signing, and signed-file archive;
- initial receivable, customer payment, callback, and write-off;
- delivery work order, Stage 2 signing, and evidence acceptance;
- authoritative order, vehicle, and lease activation;
- notification, retry, exception, and operator takeover.

The acceptance result is a new order that reliably moves from application to
active fulfillment with consistent contract, signature, collection, and
delivery facts.

### Stage 1B: Operate The Contract

Scope:

- recurring bills, active payment, and delegated collection;
- notices, retries, overdue state, and human collection tasks;
- vehicle packages, in-package swaps, protection swaps, and out-of-package
  differences;
- early termination, extension, and supplemental agreements;
- mileage, charging, swap entitlements, and customer points;
- manual odometer and charging-partner report entry;
- return, contract settlement, refund suggestion, and manual refund-result
  recording.

The acceptance result is a live contract whose bills, entitlements, changes,
and completion no longer depend on an offline master sheet.

### Stage 1C: Close Vehicle Asset Operations

Scope:

- procurement, available preparation, in-use activity, return
  reconditioning, and disposal work orders;
- vehicle restrictions and the state-impact Helper;
- repair, accident, rescue, insurance, relocation, downtime, and protection
  swap;
- actual-cost confirmation, final responsible party, recovery exposure, and
  actual recovery;
- the append-only vehicle cost ledger;
- utilization, downtime, receivable, collection, confirmed vehicle-cost, and
  recovery-exposure reports.

Stage 1 establishes shared facts without activating complete Stage 2 funding
features:

- time-bounded vehicle, order, subscription-contract, and customer relations;
- `AssetOwner`, ownership periods, and critical snapshots;
- stable source keys for cost, income, payment, and recovery;
- incurred date, attributed period, confirmation time, and immutable reversal;
- extension boundaries for future capital events and payment-source types.

Asset work orders and the immutable cost ledger belong to Stage 1. Financing
repayment, collected-rent distribution, and the unified outbound-payment
foundation do not.

### Stage 1 Metrics And Exit Gate

Primary metrics are:

- utilization, leased days, operable days, and downtime reason;
- receivable balance, aging, and collection;
- contract income, collected amount, and uncollected amount;
- confirmed direct operating cost by vehicle;
- recovery exposure by customer, insurer, supplier, or other responsible
  party.

The existing ROE remains in Stage 1 and is relabeled vehicle direct-operating
trial ROE. It continues to disclose collected-income, existing cost-parameter,
and static-equity assumptions and is not a Stage 1 core acceptance metric.
Stage 1 does not implement fully allocated management ROE.

Stage 1 completes when:

- at least 95 percent of normal orders need no operator push beyond the approved
  human steps;
- normal contracts run automatically outside the approved human steps;
- real bills and write-offs replace manual financial checkboxes;
- contract income, receivables, collections, and direct vehicle cost no longer
  rely on an offline master sheet;
- every vehicle restriction, cost, and recovery traces to source business and
  evidence;
- 1A, 1B, and 1C may release independently but are integrated at overall
  completion.

## Stage 2: Asset Capital, Debt, Revenue Rights, And Outbound Funds

Stage 2 moves current financing, asset-owner settlement, and daily-payment
spreadsheets into the system. It creates structured, settled, traceable
operating-finance facts without building an accounting general ledger.

### Stage 2A: Make Capital And Debt Data Trustworthy

Extend the current financing, capital-event, vehicle-allocation, and
revenue-right models with:

- financing contract, principal, rate, term, repayment method, and due day;
- financing deposit, performance deposit, and vehicle-specific restricted
  funds;
- amount or ratio allocated when one financing contract covers several
  vehicles;
- contract-level principal, interest, and fee schedule;
- effective-dated versions for prepayment, extension, rate change, allocation
  change, and restructuring;
- migration of valid balances, future plans, and necessary attachments from
  offline financing sheets;
- reconciliation of contract total, vehicle allocation, and outstanding
  principal.

Historical settled payments are not reconstructed as fake business events. If
needed, migration keeps only a reconciled opening balance, cumulative summary,
and original spreadsheet evidence.

### Stage 2B: Close Outbound-Payment Operations

Add the shared path:

`source payable -> daily payment batch -> finance pays offline -> operations
records the T+1 result -> business settlement`

Sources are:

- financing repayment;
- asset-work-order expense;
- collected-rent distribution;
- manually confirmed customer refund.

Capabilities are:

- rolling aggregation of due-today, older unpaid, partial, and explicit early
  payments;
- operations verification and submission, and finance acceptance or return;
- one payment settling several complete bills;
- bill and amount hold when one bill is underpaid;
- payee-level unallocated balance for an overpayment;
- refund, return, reversal, and reallocation;
- one bank statement or payment receipt per daily batch;
- in-system task, badge, and daily exception summary.

The initial Stage 2B release does not ingest the complete bank statement.
Operations records account, payee, debit date, amount, bank reference, and
selected bills inside the original payment batch. Cash-flow reporting covers
system-recorded payments only and cannot discover off-plan bank spending.

Stage 2B begins with a small set of financing contracts or payment cases in
parallel reconciliation. After amount, state, and outstanding balance are
stable, the corresponding offline master sheet becomes read-only and scope
expands in batches.

### Stage 2C: Add Distribution And Upgrade ROE

Scope:

- vehicle-level distribution based on received and settled rent;
- owner-level statement and payment for the same settlement period;
- later-period adjustment for refund, reversal, or collection correction;
- accrued operating income and confirmed actual cost;
- aging-rate plus specific receivable impairment;
- principal reduction on the actual debit date;
- time-weighted average equity;
- formal upgrade of vehicle direct-operating trial ROE with old/new
  calculation difference disclosure.

Stage 2 supports collected-rent distribution only, not net-profit sharing after
actual vehicle cost. The latter is designed separately only after cost-ledger
timeliness and accuracy are sufficient.

After the process and a fixed payment account are stable, a bank API can write
results and matching candidates into the same payment-fact model. It is a
post-Stage-2 efficiency enhancement rather than a hard Stage 2 exit gate.

### Stage 2 Exit Gate

- Active financing contracts, balances, and future schedules reconcile.
- The system generates the daily payable list and carries older unpaid items.
- Every system-managed payment traces to its source payable, result, and
  settlement.
- Principal, interest, deposits, and vehicle capital employed can be
  reconstructed by period.
- Asset-owner distribution traces from collected rent to statement and
  payment.
- Vehicle direct-operating trial ROE uses accrued income, impairment,
  confirmed cost, and time-weighted equity.

## Stage 3: Operating-Finance Analysis And Finance-Integration Readiness

Stage 3 creates the portfolio operating-finance view and forecast without
building formal accounting general ledger, tax, or automatic vouchers.

### Stage 3A: Unify Operating-Finance Facts

Scope:

- month-end operating snapshots and later version differences;
- separate accrued operating return and cash-basis cash flow;
- receivable aging, impairment, debt balance, and asset-owner payable;
- vehicle, pool, product, asset-owner, and total-portfolio analysis;
- procurement-to-disposal vehicle lifecycle settlement;
- bidirectional traceability from metrics to contract, bill, work order,
  payment, recovery, and capital event.

### Stage 3B: Forecast Funds And Assets

Forecast inputs are:

- future receivables and known changes from live contracts;
- confirmed periodic cost and source-domain payables;
- debt repayment plans and deposit return;
- utilization, delinquency, and residual scenarios;
- known disposal plans and expected disposal cash flow.

Outputs include future cash flow, debt maturity, funding gap, asset-return
change, and actual-versus-forecast difference. Forecasts use contract, plan,
and actual operating data and do not create false precision from unsupported
maintenance reserves.

### Stage 3C: Prepare Finance Integration

Add:

- versioned mapping from business events to future accounts and accounting
  dimensions;
- reconcilable income, cost, asset, debt, receipt, and payment packages;
- period summaries, variance explanation, and source-evidence links;
- stable export or interface contracts for a later finance system.

Stage 3 ends when accounting-source data is complete, mappable, and
reconcilable. It does not create or push formal vouchers or implement general
ledger, tax filing, or accounting-period close.

Stage 3 still does not add fully allocated management ROE. It is evaluated
separately after marketing cost, lead attribution, conversion, personnel, and
corporate overhead data are stable.

## Fresh Database And Test-Data Isolation

Because the system is not in material production, later development uses a
fresh database and does not design compatibility, backfill, or repair for the
current business test data.

Rules:

1. Create a full logical backup of the current test database and record
   migration version, backup time, and verification information.
2. Make the old database read-only reference. Runtime does not connect to it,
   and there is no dual-database synchronization.
3. Give the new development database a separate name and credentials and
   initialize it through the complete committed migration chain.
4. Load only role, permission, system configuration, product master data, and
   controlled test seeds.
5. Do not migrate current test orders, contracts, financing, payments, or
   settlements.
6. Never edit a committed or applied migration. Later schema changes use
   additive migrations.
7. Continue to validate fresh installation and upgrade from the new
   development baseline, but do not validate compatibility with old test
   business data.
8. Automated tests use a separate, rebuildable test database.

Keep the old read-only snapshot until overall Stage 1 acceptance. Decide cold
archive or deletion separately afterward; deletion always requires explicit
approval.

## Cross-Stage Release And Migration Rules

- Cut over one capability at a time rather than using a three-stage big bang.
- New business facts enter the system after capability cutover; do not create
  new rows in the corresponding offline master sheet.
- Any parallel validation has a bounded scope and explicit exit gate; avoid
  indefinite double entry.
- Resolve differences through auditable adjustment records rather than fake
  historical events.
- Activate a later metric only after prerequisite fact gates pass.
- Bank API, net-profit sharing, complete finance system, and fully allocated
  management ROE are maturity-triggered and not pulled into a stage early.

## Final Outcome

The completed roadmap creates this chain:

`automated subscription fulfillment -> vehicle asset operations -> capital,
debt, and revenue rights -> outbound-payment settlement -> operating-finance
statistics and forecast`

Business receives complete contract fulfillment and receivable facts.
Operations receives vehicle, work-order, cost, capital, and settlement
capabilities. Finance receives structured payment plans, cash facts,
asset/debt data, and reconcilable analysis. The system establishes stable
boundaries for a later bank API, finance-system integration, and more advanced
management metrics without becoming a complete accounting or general OA
platform in this roadmap.
