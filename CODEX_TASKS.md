# CODEX_TASKS.md

> Current baseline date: 2026-06-02  
> Current branch: `feature/ab-order-review-flow`
> Working directory: `D:\Projects\auto-subscription-platform`

This file is the executable development plan after the mainline review and
documentation calibration. Use it together with `DEV_SPEC.md`; do not treat old
Task 1-12 prompts as the active plan.

## Baseline Rules

- Work from the current local workspace, not the old OneDrive directory.
- Do not delete `ProductPriceRule`, legacy quote fields, or `RENT_TO_OWN`.
- Do not add Prisma migrations until Stage 0 quality and migration state are clear.
- Do not change quote, product, vehicle, order, or contract business code during documentation-only tasks.
- The new quote path is `vehicleId + subscriptionPlanId + vehicleBaseFeeAmount`.
- `purchasePriceAmount` is asset cost basis; `currentSalePriceAmount` is quote pricing basis.
- The vehicle package cap constrains only vehicle base fee, not full package total.
- The A/B dual-line mainline is intake first, order later:
  A line is customer self-service `Application`; B line is sales-assisted
  `Application`.
- Both lines converge at application material review, credit/deposit review,
  product-plan review, vehicle inventory review, and final-plan confirmation.
- `SubscriptionOrder` is generated only after final-plan confirmation.
- Customer-facing A-line selection uses preset active `SubscriptionPlan`
  records only, not free package composition.
- Keep `SubscriptionQuote` as the final price and plan snapshot object.
- Extend `Application` for self-service intake state in the first version.
- Existing `POST /api/customer-orders`, `CUSTOMER_SELF_SERVICE` direct orders,
  and `/orders/review` are legacy artifacts pending R2-R5 migration.
- If seed changes permissions, users must seed again and re-login to refresh JWT permissions.

## Stage 0: Baseline Handover And Quality Gates

**Goal**

Stabilize the current uncommitted local baseline and establish reliable quality
gates before further feature work.

**Scope**

- Review uncommitted files and classify code, docs, migrations, and tests.
- Verify schema, generated Prisma client, lint, typecheck, tests, and migration status.
- Confirm remote PostgreSQL through SSH tunnel or local Docker PostgreSQL is usable.
- Reconcile docs with actual code status.

**Do Not**

- Do not implement new business features.
- Do not change pricing, product, vehicle, order, or contract logic unless a quality gate cannot pass without a narrowly scoped fix.
- Do not run `prisma migrate reset`.

**Data Model**

- Inspect existing migrations through `20260602110000_vehicle_sale_price_review_reinit`.
- Confirm whether untracked migrations are intended and applied.

**Backend APIs**

- Validate current API shape only.
- Pay special attention to `/api/vehicles/available` and quote creation dependencies.

**Frontend Pages**

- Validate existing pages load and do not block critical flows.
- Note Ant Design deprecations for later fixes.

**Permissions**

- Confirm `ADMIN` can access vehicles and quote creation dependencies.
- Identify missing fine-grained `vehicle:*` and `subscription_plan:*` permissions.

**Tests**

- Run the full quality gate listed in `README.md`.
- If failure occurs, capture exact command and error.

**Acceptance**

- Current branch and dirty working tree are documented.
- Migration state is known.
- Quality gate pass/fail is recorded.
- A commit boundary is recommended but not pushed to main.

## Stage 1: Permission System And Seed/JWT Calibration

**Goal**

Unify shared permission constants, seed role grants, frontend menus/buttons, and
backend `RequirePermissions`.

**Scope**

- Add fine-grained vehicle permissions:
  `vehicle:view`, `vehicle:create`, `vehicle:update`, `vehicle:delete`,
  `vehicle:update_status`, `vehicle:initialize_sale_price`,
  `vehicle:review_sale_price`, `vehicle:history_view`.
- Add subscription plan permissions:
  `subscription_plan:view`, `subscription_plan:create`,
  `subscription_plan:update`, `subscription_plan:activate`,
  `subscription_plan:deactivate`, `subscription_plan:delete`.
- Confirm package permissions:
  `vehicle_package:*`, `mileage_package:*`, `energy_package:*`, `benefit_package:*`.
- Confirm `quote:*` and `application:*` support quote preflight calls.

**Do Not**

- Do not change quote formulas.
- Do not change vehicle status business rules.
- Do not grant broad permissions to non-admin roles without role rationale.

**Data Model**

- No schema change expected if permissions are seeded into existing `permission`,
  `role_permission`, `menu`, and `role_menu`.

**Backend APIs**

- Update `VehicleController` and `ProductController` permission decorators.
- Ensure `/api/vehicles/available` is available to users allowed to create quotes.

**Frontend Pages**

- Keep menu visibility aligned with `packages/shared/src/menus.ts`.
- Gate buttons for vehicle sale price initialization/review/status change.

**Permissions**

- `ADMIN`: all permissions.
- `SA`: customer/application/quote creation, read active products and available vehicles.
- `OP`: product, subscription plan, quote, order, contract operations.
- `AS`: vehicle asset and sale price operations.
- `RC`, `FI`, `GM`: read/approve scopes by responsibility.

**Tests**

- Permission guard tests for allowed/denied users.
- Seed/JWT refresh scenario documented.

**Acceptance**

- Admin can access vehicle list and create quote.
- User without permission receives 403 with Chinese message.
- Seeded permissions appear in system permission page.
- Users are told to re-login after seed updates.

## Stage 2: Vehicle Asset Pool Stabilization

**Goal**

Stabilize vehicle acquisition, preparation, availability, sale price
initialization, quarterly review, and return-to-pool reinitialization.

**Scope**

- Harden `Vehicle`, `VehicleSalePriceHistory`, and planned `VehicleStatusLog`.
- Decide whether current enum values remain or are migrated toward:
  `PURCHASED`, `PREPARING`, `PLATED`, `INSURED`, `AVAILABLE`, `RESERVED`,
  `LEASED`, `MAINTENANCE`, `RETURNED`, `DISPOSAL_PENDING`, `SOLD`.
- Enforce available-pool rules and sale price review dates.

**Do Not**

- Do not create status enum migrations until the Stage 0 migration state is clean.
- Do not remove existing `RENTED` or `RETIRED` values without migration planning.

**Data Model**

- Current: `Vehicle`, `VehicleSalePriceHistory`.
- Planned: `VehicleStatusLog` or equivalent lifecycle/status log.
- Key fields: `purchasePriceAmount`, `currentSalePriceAmount`,
  `salePriceStatus`, `nextSalePriceReviewAt`, `salePriceReinitRequiredAt`.

**Backend APIs**

- `GET /api/vehicles`
- `GET /api/vehicles/available`
- `POST /api/vehicles`
- `PATCH /api/vehicles/:id`
- `POST /api/vehicles/:id/update-status`
- `POST /api/vehicles/:id/initialize-sale-price`
- `POST /api/vehicles/:id/review-sale-price`
- `GET /api/vehicles/:id/sale-price-history`
- `GET /api/vehicles/sale-price-reviews/due`

**Frontend Pages**

- `/vehicles`
- Sale price history modal
- Initialization/review/status forms

**Permissions**

- Fine-grained `vehicle:*` permissions from Stage 1.

**Tests**

- Blocks `AVAILABLE` without effective `currentSalePriceAmount`.
- Quarterly review due list.
- `RETURN_REINIT` required before returned vehicle re-enters `AVAILABLE`.
- Audit/status log expectations.

**Acceptance**

- Available vehicle pool only returns vehicles with `AVAILABLE` and effective sale price.
- Returned vehicles cannot re-enter the pool without reinitialization.
- Sale price history is complete and auditable.

## Stage 3: Product Center Subscription Package Stabilization

**Goal**

Make product center produce sellable `SubscriptionPlan` packages instead of
requiring sales to combine raw rules manually.

**Scope**

- Stabilize `Product`, `ProductVersion`, `VehiclePackage`, `MileagePackage`,
  `EnergyPackage`, `BenefitPackage`, `SubscriptionPlan`.
- Keep `ProductPriceRule` for legacy compatibility.
- Product version activation depends on at least one active `SubscriptionPlan`.

**Do Not**

- Do not delete `ProductPriceRule`.
- Do not re-enable `RENT_TO_OWN` UI or creation paths.
- Do not force legacy quotes into package snapshots retroactively.

**Data Model**

- Package tables are under product version.
- `SubscriptionPlan` references one vehicle package, one mileage package, one
  energy package, and optional benefit package.

**Backend APIs**

- Product/version CRUD and activation.
- Package CRUD and activation.
- `subscription-plans` CRUD and activation.
- Available subscription plan lookup for approved applications.

**Frontend Pages**

- `/products` with product, version, package, and subscription plan tabs.

**Permissions**

- `product:*`, package permissions, and `subscription_plan:*`.

**Tests**

- Active plan is required for product version activation.
- Inactive components block active/sellable plans.
- Legacy `ProductPriceRule` quote remains readable and confirmable.

**Acceptance**

- Sales can select an active plan for an approved application.
- Legacy quote records still render and can follow their supported workflow.

## Stage 4: Sales-Assisted Application Quote Closed Loop

**Goal**

For approved sales-assisted applications, generate quotes from a concrete
vehicle and an active subscription plan.

**Scope**

- Select `vehicleId`.
- Select `subscriptionPlanId`.
- Read `currentSalePriceAmount`.
- Calculate vehicle base fee cap.
- Enter vehicle base fee quote.
- Add package prices.
- Save `vehicleSnapshot`, `packageSnapshot`, and `depositRuleSnapshot`.
- Preserve this path as B-line `SALES_ASSISTED`: review first, order later.

**Do Not**

- Do not calculate vehicle base fee from `purchasePriceAmount`.
- Do not apply the 3.5% cap to the full package total.
- Do not lock the vehicle when merely generating a quote.

**Data Model**

- `SubscriptionQuote.vehicleId`
- `SubscriptionQuote.subscriptionPlanId`
- `vehicleSalePriceAmount`
- `vehicleBaseFeeAmount`
- `vehicleBaseFeeCapAmount`
- package price fields and snapshots

**Backend APIs**

- `GET /api/applications/:id/available-subscription-plans`
- `GET /api/vehicles/available`
- `POST /api/applications/:id/quotes`
- `POST /api/quotes/:id/confirm`
- `POST /api/quotes/:id/cancel`

**Frontend Pages**

- `/applications/[id]` quote modal
- `/quotes`
- `/quotes/[id]`

**Permissions**

- `quote:create` must include permission to read required active plans and available vehicles.

**Tests**

- Approved-only quote creation.
- Vehicle sale price cap formula.
- Package total can exceed vehicle base fee cap.
- Snapshot persistence.

**Acceptance**

- Quote creation succeeds for approved application with available vehicle and active plan.
- Quote detail shows vehicle and package snapshots.
- Permission denied issue for `/api/vehicles/available` is resolved.
- B-line sales-assisted quote creation remains backward compatible with the
  existing application, risk, quote, order, and contract pages.

## Stage 5: A/B Intake, Final Plan, Orders, And Vehicle Status Linkage

**Goal**

Connect A-line customer self-service applications and B-line sales-assisted
applications into one intake review, final-plan confirmation, quote, order,
contract, vehicle reservation, cancellation, and rollback model.

**Stage 5.5 Recalibration Sequence**

```text
R0: Confirm branch and mark old customer-orders direction as pending migration
R1: Documentation calibration plus Application model extension
R2: Add POST /api/self-service-applications
R3: Move A-line review APIs from order review to application review
R4: Adapt application list/detail review workspace
R5: Deprecate or compat-wrap customer-orders and orders/review
R6: Seed, tests, quality gates, and PR cleanup
```

**Scope**

- Keep B-line confirmed quote locking: `AVAILABLE -> RESERVED`.
- Add A-line customer self-service intake:
  customer selects a concrete vehicle and preset active `SubscriptionPlan`,
  submits a `SELF_SERVICE` `Application`, and the system stores intent
  snapshots on the application without creating a formal order.
- Add merged application review for materials, credit/deposit, product match,
  and vehicle inventory.
- Add final deposit confirmation after review; customer submission keeps deposit
  pending.
- Add final-plan confirmation before quote/order creation.
- Create subscription order from confirmed B-line quote.
- Generate, sign, archive, cancel contracts.
- Order cancellation releases vehicle when applicable.
- Contract termination starts return flow.
- Preserve the customer second-confirmation extension point before contract
  signing.

**Do Not**

- Do not implement full delivery, billing, or guarantee deposit flows here.
- Do not alter quote formula.
- Do not expose customer free composition of vehicle, mileage, energy, and
  benefit packages.
- Do not remove existing sales-assisted quote generation.

**Data Model**

- `Application`
- `SubscriptionOrder`
- `Contract`
- `ContractVersion`
- `OrderChange`
- `SubscriptionOrder.vehicleId`
- Keep `SubscriptionQuote` as the final price and plan snapshot object.
- Do not add `SubscriptionOrderApplication` in the first version.
- Extend `Application` with:
  `applicationSource`, intent vehicle/plan/period/base-fee fields,
  `intentSnapshot`, `customerSelectedSnapshot`, final vehicle/plan/period/base-fee
  fields, `finalQuoteSnapshot`, `finalPlanSnapshot`, review statuses,
  `depositStatus`, `finalDepositAmount`, and soft-reservation fields.
- Suggested `applicationSource` values:
  `SELF_SERVICE`, `SALES_ASSISTED`.
- Suggested review values:
  `PENDING`, `APPROVED`, `REJECTED`, `NEED_MORE_INFO`.
- Suggested A-line application initial state:
  `applicationSource = SELF_SERVICE`, `status = SUBMITTED`, review statuses
  `PENDING`, `depositStatus = PENDING_CONFIRM`, and `finalDepositAmount = null`.
- Formal `SubscriptionOrder` is generated only after final-plan confirmation.
- Evaluate adding `VehicleStatus.REVIEW_RESERVED` as the target inventory hold
  state for A-line review.

**Backend APIs**

- `POST /api/orders/from-quote/:quoteId`
- `POST /api/orders/:id/cancel`
- `POST /api/orders/:id/generate-contract`
- contract sign/archive/cancel endpoints
- order change approval endpoints
- Proposed A-line customer API:
  `POST /api/self-service-applications`.
- Proposed merged back-office review APIs:
  application review queue, material/credit/product/vehicle review actions,
  final-plan confirmation, and quote/order creation.
- Legacy direct-order API:
  `POST /api/customer-orders` remains temporarily for compatibility and is
  pending R2-R5 migration.

**Frontend Pages**

- `/orders`
- `/orders/[id]`
- `/contracts`
- `/contracts/[id]`
- `/contract-versions`
- Back-office application review queue and application detail review panel for
  A-line.
- Future customer-facing confirmation page; first version may use a back-office
  "confirm final plan" action while preserving the status extension point.

**Permissions**

- `order:*`, `order_change:*`, `contract:*`, vehicle status permissions.
- Recommended additions or splits:
  `order:review`, `order:confirm_final_plan`, and read access to vehicles,
  active subscription plans, and deposit rules for reviewers.

**Tests**

- Confirm quote locks vehicle.
- Order cancellation releases vehicle.
- Contract cancellation/termination paths preserve audit trail.
- A-line submission creates a `SELF_SERVICE` `Application` and snapshots with
  pending deposit.
- A-line review writes final deposit from A/B/C grade, deposit rule, and risk result.
- Changed final deposit or plan waits for application final-plan confirmation.
- A-line vehicle status follows `AVAILABLE -> REVIEW_RESERVED -> RESERVED`
  when `REVIEW_RESERVED` is implemented; otherwise document and test the
  temporary `RESERVED` fallback.

**Acceptance**

- Vehicle cannot be double reserved.
- Order/contract transitions are auditable.
- Cancelled quote/order releases reserved vehicle when business rules allow it.
- B-line sales-assisted flow remains compatible with current quote/order pages.
- A-line minimum first version supports customer self-service application
  submission, back-office review, final deposit confirmation, final-plan
  confirmation, and contract entry after formal order creation.

## Stage 6: Vehicle Delivery, Return, And Re-Pooling

**Goal**

Support delivery readiness, handover, return inspection, reconditioning, and
return-to-pool sale price reinitialization.

**Scope**

- Delivery checklist.
- Insurance validity.
- Deposit and first monthly fee preconditions.
- Return inspection and damage records.
- `RETURN_REINIT` before re-entering available pool.

**Do Not**

- Do not implement accounting settlement beyond required state prerequisites.
- Do not skip audit/status logs for handover and return.

**Data Model**

- Planned delivery and return tables.
- Vehicle status/lifecycle log.
- Sale price reinit fields on `Vehicle`.

**Backend APIs**

- Delivery order and handover endpoints.
- Return order and inspection endpoints.
- Vehicle status updates tied to delivery/return.

**Frontend Pages**

- Delivery center pages.
- Return management pages.
- Vehicle detail return/re-pool actions.

**Permissions**

- `delivery:*`, `return:*`, `vehicle:update_status`, `vehicle:initialize_sale_price`.

**Tests**

- Delivery blocks until contract, deposit, first fee, insurance, and vehicle state are valid.
- Return requires inspection result.
- Re-pooling requires sale price reinitialization.

**Acceptance**

- Delivered vehicle enters leased/in-use state.
- Returned vehicle cannot be leased again until reconditioned and sale price is effective.

## Stage 7: Billing, Deposits, Collection, And Benefits

**Goal**

Close the operating cash-flow loop.

**Scope**

- Bills and bill items.
- Payments and write-off.
- Deposit account and deposit transactions.
- Deposit deductions/refunds.
- Overdue collection.
- Benefit grants and consumption.

**Do Not**

- Do not build ROA/ROE reports before reliable financial records exist.
- Do not allow deposit changes without transaction records.

**Data Model**

- `bill`, `bill_item`, `payment`, `writeoff_record`
- `deposit_account`, `deposit_transaction`
- `overdue_record`, `collection_task`, `default_event`
- benefit and points account tables

**Backend APIs**

- Billing generation and payment/write-off endpoints.
- Deposit account/deduction/refund endpoints.
- Collection task endpoints.
- Benefit grant/use endpoints.

**Frontend Pages**

- Billing center.
- Deposit pool.
- Collection center.
- Benefits center.

**Permissions**

- Finance, collection, and benefit permissions by role.

**Tests**

- Deposit movements generate transactions.
- Write-off closes bills correctly.
- Overdue classification works.
- Benefit consumption leaves ledger records.

**Acceptance**

- Every money movement is traceable.
- Deposit balance equals received minus refunded minus deducted/frozen amounts.

## Stage 8: Asset Operations And ROA/ROE Reports

**Goal**

Evaluate operating quality across each vehicle lifecycle.

**Scope**

- Vehicle lifecycle events.
- Purchase price, current sale price, depreciation, utilization, revenue, cost,
  cash flow, ROA, and ROE.
- Asset quality reports and fleet dashboards.

**Do Not**

- Do not calculate reports from incomplete or inconsistent finance data.
- Do not mix quote pricing basis with asset cost basis.

**Data Model**

- Planned `vehicle_lifecycle_event`.
- Report snapshot tables if realtime calculation becomes expensive.

**Backend APIs**

- Fleet report.
- Asset quality report.
- Revenue report.
- ROA/ROE report.

**Frontend Pages**

- Dashboard.
- Report center.

**Permissions**

- Report view/export permissions.

**Tests**

- ROA/ROE formulas.
- Vehicle lifecycle revenue/cost aggregation.
- Report date filters.

**Acceptance**

- Single vehicle lifecycle can be traced from purchase to operation to disposal.
- ROA/ROE reports use purchase price for cost basis and sale price for pricing snapshots only.

## Stage 9: Launch Readiness And CI/CD

**Goal**

Make the system stable enough for deployment, rollback, regression testing, and
manual acceptance.

**Scope**

- CI quality gates.
- Test coverage.
- Seed strategy.
- Environment variable templates.
- Deployment documentation.
- Data backup and restore plan.
- Permission initialization.
- Manual acceptance checklist.

**Do Not**

- Do not deploy with pending migrations or undocumented environment variables.
- Do not rely on local-only seed state for production roles.

**Data Model**

- Confirm final migration history and production migration process.

**Backend APIs**

- Health checks and smoke paths.
- Deployment observability hooks as needed.

**Frontend Pages**

- Manual acceptance paths documented in README.

**Permissions**

- Production permission matrix exported and reviewed.

**Tests**

- CI runs lint, Prisma validate/generate, typecheck, API tests, and smoke checks.

**Acceptance**

- Fresh environment can be provisioned from documented steps.
- CI catches regressions.
- Rollback and backup plans are documented.
