# 纯电汽车订阅运营中台主线规格

> Calibrated at: 2026-06-02  
> Repository: `keqi119/subscription-Saas`  
> Branch: `feature/ab-order-review-flow`
> Local workspace: `D:\Projects\auto-subscription-platform`

This document is the current mainline specification for Codex, developers,
product, and QA. It replaces the earlier V1.0 draft as the active source of
truth. If this file conflicts with old task prompts or old README text, follow
this file.

## 0. Current Positioning

The system is an internal Back Office for China mainland used EV subscription
operations, starting from Shanghai. It supports the operational chain from
customer onboarding through risk approval, subscription quote, order, contract,
vehicle asset operations, and later billing/asset reporting.

Current active product line:

- `SUBSCRIPTION`: active and buildable.
- `RENT_TO_OWN`: retained in enums, fields, permissions, and historical data,
  but not exposed as an active creation flow.

Current development focus:

- Stabilize the local Stage 5 optimization baseline.
- Backfill product package, vehicle sale price, and quote formula changes into documentation.
- Add the A/B dual-line order mainline before the next business-code round.
- Establish a new Stage 0-9 execution plan before further feature work.

## 1. Current Actual Progress

The local workspace contains a monorepo implementation that is ahead of
GitHub `main`. `origin/main` is still close to the initial upload, while the
local branch contains `apps/`, `packages/`, Prisma schema, migrations, API,
web pages, and tests. Use the local workspace as the baseline.

Completed or mostly completed:

- Monorepo with `apps/api`, `apps/web`, and `packages/shared`.
- Auth, JWT Cookie, RBAC, menu permissions, user/role/permission management.
- Audit log infrastructure.
- Customer center and application management.
- Material upload/review workflow.
- Risk approval and A/B/C deposit rules.
- Product center with product, product version, legacy price rules, packages,
  and subscription plans.
- Quote creation, quote detail, quote confirmation, and legacy quote compatibility.
- Order and contract baseline, contract templates, and order change workflow.
- Vehicle module with asset records, sale price initialization, quarterly review,
  sale price history, and available vehicle API.

Partially completed:

- Fine-grained permission matrix for vehicle and subscription plan operations.
- Vehicle status model and status history logging.
- Quote-to-order-to-vehicle status closed loop beyond quote confirmation.
- Ant Design v6 deprecation cleanup.
- Full quality gate and migration status verification.

Known blockers or risks:

- The local working tree has many uncommitted files and untracked migrations.
- `prisma migrate status` currently fails with a Prisma schema engine error.
- `/api/vehicles/available` may fail for users whose JWT lacks `vehicle:view`.
- Current code has `vehicle:view` and `vehicle:manage`, but not all required
  fine-grained vehicle permissions.
- `subscription_plan:*` permissions are not yet split from `product:*`.

## 2. Engineering Rules

- Read this file before changing business logic.
- Do not delete `ProductPriceRule`.
- Do not delete legacy quote fields.
- Do not delete or expose `RENT_TO_OWN` without explicit user request.
- Do not run `prisma migrate reset` unless explicitly approved.
- All money is stored in cents.
- Status fields must use enums.
- Critical operations must write audit logs or equivalent status history.
- In each task, run `git status --short` and migration status before coding.

## 3. Product Center Mainline

The product center has moved from old flat price rules to subscription package
composition.

Old model retained for compatibility:

```text
Product -> ProductVersion -> ProductPriceRule
```

Current mainline model:

```text
Product
  -> ProductVersion
  -> VehiclePackage / MileagePackage / EnergyPackage / BenefitPackage
  -> SubscriptionPlan
  -> SubscriptionQuote
```

`ProductPriceRule`:

- Legacy price rule.
- Kept for old quotes and historical data.
- Not a required condition for new product version activation.
- Must not be deleted.

`SubscriptionPlan`:

- New sellable subscription package.
- References one `VehiclePackage`, one `MileagePackage`, one `EnergyPackage`,
  and optional `BenefitPackage`.
- Can be sold only when status is `ACTIVE`, within effective date range, and
  all linked package components are active.
- New quote creation uses `subscriptionPlanId`.

Product version activation rule:

- A product version must have at least one active `SubscriptionPlan`.
- Active plans must only reference active package components from the same
  product and version.

## 4. Vehicle Asset Pool Mainline

Vehicle management is responsible for asset cost, current sale price, sale price
review, status, and availability.

Current code models:

- `Vehicle`
- `VehicleSalePriceHistory`

Planned or to be stabilized:

- `VehicleStatusLog` or equivalent dedicated status lifecycle log.
- Full delivery/return/re-pooling lifecycle events.

Key fields:

```text
purchasePriceAmount           vehicle purchase cost basis
currentSalePriceAmount        current vehicle sale price used for quote pricing
currentSalePriceInitializedAt sale price initialization timestamp
currentSalePriceReviewedAt    latest sale price review timestamp
nextSalePriceReviewAt         next quarterly review date
salePriceReinitRequiredAt     return-to-pool reinit marker
salePriceStatus               PENDING_INITIALIZE / EFFECTIVE / REVIEW_DUE / EXPIRED
```

Never mix pricing basis:

- `purchasePriceAmount` is used for asset cost, depreciation, ROA/ROE, and lifecycle reports.
- `currentSalePriceAmount` is used for subscription quote pricing.

Current code status enum:

```text
DRAFT
IN_PREPARATION
AVAILABLE
RESERVED
LEASED
RENTED
RETURNED
MAINTENANCE
RETIRED
```

Target status model to evaluate in Stage 2/5:

```text
PURCHASED
PREPARING
PLATED
INSURED
AVAILABLE
RESERVED
LEASED
MAINTENANCE
RETURNED
DISPOSAL_PENDING
SOLD
```

Do not migrate status enum values until current migration state is clean and a
backfill plan exists.

## 5. Sale Price Lifecycle

Business rules:

- New pool vehicles must initialize `currentSalePriceAmount`.
- Sale price must be reviewed at least quarterly.
- Returned vehicles must reinitialize sale price before becoming available again.
- Vehicles without effective sale price cannot enter `AVAILABLE`.
- Quote creation must use `currentSalePriceAmount`.

Current APIs:

```http
GET  /api/vehicles
GET  /api/vehicles/available
GET  /api/vehicles/sale-price-reviews/due
GET  /api/vehicles/:id/sale-price-history
POST /api/vehicles
PATCH /api/vehicles/:id
POST /api/vehicles/:id/initialize-sale-price
POST /api/vehicles/:id/review-sale-price
POST /api/vehicles/:id/update-status
```

Availability rule:

```text
vehicle.status == AVAILABLE
salePriceStatus == EFFECTIVE
currentSalePriceAmount > 0
deletedAt == null
```

Return-to-pool rule:

```text
LEASED / RENTED / RESERVED / RETURNED / MAINTENANCE
  -> salePriceReinitRequiredAt marked when leaving the normal available pool
  -> RETURN_REINIT sale price history required
  -> AVAILABLE allowed only after effective reinitialization
```

## 6. Quote Logic Mainline

New subscription quote flow:

```text
Application APPROVED
  -> select concrete vehicle VIN / plate
  -> select active SubscriptionPlan
  -> system reads Vehicle.currentSalePriceAmount
  -> system calculates vehicle base fee cap
  -> user enters vehicleBaseFeeAmount
  -> system adds mileage, energy, and benefit package prices
  -> system saves quote snapshots
```

Vehicle base fee cap:

```text
vehicleBaseFeeCapAmount = currentSalePriceAmount * vehiclePackage.monthlyFeeRate
```

This is not:

```text
purchasePriceAmount * vehiclePackage.monthlyFeeRate
```

Package total:

```text
monthlyFeeAmount =
vehicleBaseFeeAmount
+ mileagePackagePriceAmount
+ energyPackagePriceAmount
+ benefitPackagePriceAmount
```

Important:

- The vehicle package rate, including a 3.5% style cap, constrains only
  `vehicleBaseFeeAmount`.
- The total subscription package price may be higher than the vehicle base fee cap.
- Old quote flows without `subscriptionPlanId` or snapshots remain readable and confirmable.

Quote fields:

```text
subscriptionPlanId
vehicleId
vehicleSalePriceAmount
vehicleBaseFeeCapAmount
vehicleBaseFeeAmount
mileagePackagePriceAmount
energyPackagePriceAmount
benefitPackagePriceAmount
packageSnapshot
depositRuleSnapshot
vehicleSnapshot
```

## 7. A/B Dual-Line Application Intake Mainline

The calibrated mainline is application intake first, order later. Both A and B
lines converge on `Application` review before a formal `SubscriptionOrder`
exists.

### A Line: Customer Self-Service

Target flow:

```text
Customer views vehicles
  -> selects a concrete vehicle
  -> selects a preset SubscriptionPlan
  -> submits a self-service application
  -> system stores the customer's intent snapshot on Application
  -> back office reviews materials, credit/deposit, product match, and vehicle inventory
  -> back office confirms the final plan
  -> system creates/confirms SubscriptionQuote
  -> system creates SubscriptionOrder
  -> contract signing
```

Business principles:

- A line is `SELF_SERVICE` `Application` creation, not formal order creation.
- The customer-selected plan is an intent plan, not the final signing plan and
  not a formal `SubscriptionOrder`.
- Customer-facing UI may only expose preset active `SubscriptionPlan` options.
- Customer-facing UI must not expose free package composition:
  `VehiclePackage + MileagePackage + EnergyPackage + BenefitPackage`.
- The deposit amount is pending when the customer submits and is finalized only
  after qualification/risk review.

Customer-facing copy:

```text
您当前选择的是意向订阅方案。押金金额将根据您的资质审核结果、信用等级及平台风控规则最终确认。审核通过后，平台将向您展示最终签约方案，您确认后再进入合同签署流程。
```

Primary customer action text should be:

```text
提交审核
```

Do not label the first A-line action as:

```text
立即下单
```

### B Line: Sales Assisted

Current and continuing back-office flow:

```text
Customer creation / application
  -> risk review
  -> customer grading
  -> sales selects vehicle and SubscriptionPlan
  -> create quote / order
  -> contract signing
```

Business principles:

- B line is `SALES_ASSISTED` `Application` creation.
- B line remains review first, quote/order later.
- Reuse the existing customer, application, risk, quote, order, and contract
  flow instead of replacing it.

### Unified Application Model Direction

First-version recommendation:

- Extend `Application`, not `SubscriptionOrder`, for A-line intake review state.
- Add `applicationSource` to distinguish `SELF_SERVICE` and `SALES_ASSISTED`.
- Store customer intent fields and snapshots on `Application`.
- Store final plan fields and snapshots on `Application` before quote/order
  creation.
- Reuse existing review/deposit enums where practical.
- Keep `SubscriptionQuote` as the final price and plan snapshot object.
- `SubscriptionOrder` represents a formal pre-contract order generated only
  after material, credit/deposit, product-plan, vehicle-inventory, and final
  plan confirmation.
- Do not add `SubscriptionOrderApplication` in the first version.

Recommended A-line initial values on `Application`:

```text
applicationSource = SELF_SERVICE
status = SUBMITTED
materialReviewStatus = PENDING
creditReviewStatus = PENDING
productReviewStatus = PENDING
vehicleReviewStatus = PENDING
depositStatus = PENDING_CONFIRM
planConfirmStatus = PENDING
finalDepositAmount = null
```

B-line applications keep the compatible source default:

```text
applicationSource = SALES_ASSISTED
```

### Legacy Stage 5.5 Artifacts

The current branch already contains legacy A-line direct-order artifacts:

```text
POST /api/customer-orders
CUSTOMER_SELF_SERVICE direct SubscriptionOrder records
GET /api/orders/review-queue
/orders/review
```

These are retained temporarily for compatibility and test stability, but they
are no longer the target mainline. Later R2-R5 work will migrate the behavior
to self-service applications and application review.

### Deposit Confirmation

A-line application submission must keep the deposit pending:

```text
depositStatus = PENDING_CONFIRM
finalDepositAmount = null
depositRuleSnapshot = null
```

After review, the platform writes the final deposit from customer grade,
deposit rules, and risk result:

```text
customerGrade
depositRuleId
depositRuleSnapshot
finalDepositAmount
defaultRate
```

If the final deposit, selected vehicle, subscription plan, period, or monthly
fee differs from the customer's original intent, the application should wait
for final-plan confirmation before quote/order creation.

### Vehicle Status Linkage

Target first-version vehicle transitions:

```text
A line self-service application submission: AVAILABLE -> REVIEW_RESERVED
A line review failure / customer cancellation: REVIEW_RESERVED -> AVAILABLE
A line final plan confirmed and order entry: REVIEW_RESERVED -> RESERVED
B line quote confirmation: AVAILABLE -> RESERVED
Contract signing / payment / delivery follow-up: RESERVED -> LEASED
```

`REVIEW_RESERVED` separates "inventory held for review" from "vehicle reserved
for signing" and is the target status for A-line self-service application holds.

### Object Relationships

Mainline relationship:

```text
Application
  -> SubscriptionQuote
  -> SubscriptionOrder
  -> Contract

Product
  -> ProductVersion
  -> SubscriptionPlan
  -> SubscriptionQuote

Vehicle
  -> Application intent/final vehicle fields
  -> SubscriptionQuote.vehicleId
  -> SubscriptionOrder.vehicleId
```

`SubscriptionPlan` remains the customer-facing sellable package. Package
components remain back-office product-center configuration only.

## 8. Vehicle Lock And Release Rules

Mainline rules:

- Generating a quote does not lock a vehicle.
- B-line quote confirmation locks a vehicle: `AVAILABLE -> RESERVED`.
- A-line self-service application submission should hold inventory as
  `AVAILABLE -> REVIEW_RESERVED` in the target model.
- Creating an order from a confirmed quote keeps the selected vehicle on the order.
- Delivery moves reserved vehicle toward leased/in-use state.
- Quote cancellation or order cancellation releases a reserved vehicle when no active contract/order blocks release.
- Contract termination starts return flow and re-pooling requirements.

Current implementation status:

- Quote confirmation already updates selected vehicle to `RESERVED`.
- Order/contract/delivery return status linkage needs Stage 5/6 stabilization.

## 9. Permissions

Existing permissions include:

```text
application:*
quote:*
vehicle_package:*
mileage_package:*
energy_package:*
benefit_package:*
vehicle:view
vehicle:manage
```

Required calibration:

```text
vehicle:view
vehicle:create
vehicle:update
vehicle:delete
vehicle:update_status
vehicle:initialize_sale_price
vehicle:review_sale_price
vehicle:history_view

subscription_plan:view
subscription_plan:create
subscription_plan:update
subscription_plan:activate
subscription_plan:deactivate
subscription_plan:delete
```

Permission updates must be synchronized across:

- `packages/shared/src/auth.ts`
- `apps/api/prisma/seed.mjs`
- `packages/shared/src/menus.ts`
- backend `RequirePermissions`
- frontend menu/button guards

`ADMIN` must have all permissions. `OP`, `SA`, and `AS` should be granted by
business responsibility. After seed changes, users must re-login to refresh JWT
permissions.

## 10. Audit And Status Logging

Audit logs are required for:

- customer and application changes
- risk decisions
- product/package/plan changes
- quote creation, update, confirmation, and cancellation
- vehicle sale price initialization/review
- vehicle status changes
- order, contract, and order change transitions
- billing, payment, deposit, collection, and benefit changes

Current vehicle status changes write audit logs. A dedicated
`VehicleStatusLog` or lifecycle event table remains a Stage 2/5 decision.

## 11. Testing Requirements

Write or update tests when touching:

- price calculation and quote snapshots
- `purchasePriceAmount` vs `currentSalePriceAmount` behavior
- vehicle availability and sale price review rules
- vehicle status transitions
- quote confirmation and vehicle reservation
- order and contract status transitions
- deposit, billing, payment, write-off, or guarantee fund logic
- permission checks affecting protected APIs, menus, or buttons

Quality gate:

```powershell
pnpm -r lint
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

## 12. Current Code / Documentation Differences

Known differences after review:

- GitHub `main` does not reflect local monorepo implementation; local workspace is current baseline.
- `apps/api/src/application` does not exist; application logic currently lives in `apps/api/src/customer`.
- `VehicleStatusLog` is not implemented as a separate table.
- Vehicle status enum in code differs from the target business status list.
- `vehicle:*` and `subscription_plan:*` fine-grained permissions are not fully implemented.
- `ProductController` currently protects `subscription-plans` with `product:*` permissions.
- `VehicleController` currently protects sale price and status operations with `vehicle:manage`.
- Ant Design `Space direction` remains in `apps/web/src/app/vehicles/page.tsx`.
- Some Drawer/Modal sizing may need Ant Design v6 cleanup.
- Migration status must be rechecked because current Prisma status command fails.

## 13. Stage Plan Summary

Detailed execution scope is in `CODEX_TASKS.md`.

| Stage | Name | Main Objective |
|---|---|---|
| 0 | Baseline handover and quality gates | classify dirty working tree, verify migrations, run quality gates |
| 1 | Permission and seed/JWT calibration | sync shared auth, seed, menus, backend guards, JWT refresh guidance |
| 2 | Vehicle asset pool stabilization | harden sale price lifecycle, available pool, status logging |
| 3 | Product subscription package stabilization | make `SubscriptionPlan` the stable sellable package |
| 4 | Application quote closed loop | quote from approved application, concrete vehicle, active plan |
| 5 | Orders/contracts/vehicle linkage | lock/release vehicle through quote, order, contract transitions |
| 6 | Delivery, return, re-pooling | delivery checks, return inspection, sale price reinit |
| 7 | Billing, deposits, collection, benefits | cash-flow and guarantee fund ledger |
| 8 | Asset operations and ROA/ROE | lifecycle events, asset quality and financial reports |
| 9 | Launch readiness and CI/CD | CI, deployment, seed strategy, backups, manual acceptance |

## 14. Stage 0 Priorities

Handle these before new business development:

1. Fix or document the current `prisma migrate status` failure.
2. Confirm untracked migrations are intended and applied.
3. Fix product/subscription plan mock typecheck if present in quality gate.
4. Fix `/api/vehicles/available` permission/JWT issue.
5. Fix Ant Design deprecation warnings.
6. Run the full quality gate.
7. Commit the reviewed baseline on the feature branch, not on `main`.
