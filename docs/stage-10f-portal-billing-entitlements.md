# Stage 10F Portal Billing, Deposit, and Entitlement Center

> Date: 2026-06-18  
> Branch: `feature/stage10-portal-billing-entitlements`  
> Scope: customer-facing read-only order, bill, payment, deposit, and entitlement center.

## 1. Goal

Stage 10F completes the customer履约 information layer after application, contract signing, and payment foundations are in place.

The stage lets a logged-in Portal customer view:

- My orders.
- My bills and bill details.
- Payment orders and payment records.
- Deposit overview and deposit ledger transactions.
- Entitlement grants and usage records.

This stage does not introduce new finance, deposit, or entitlement write logic. It exposes existing domain data through customer-owned, redacted Portal APIs and H5 pages.

## 2. Existing Reused Capabilities

Reusable backend models and services:

- `SubscriptionOrder` owns the customer order and links customer, vehicle, contract, bills, payment orders, deposit ledgers, and entitlements.
- `ReceivableBill` stores bill amount, paid amount, remaining amount, due date, bill period, and bill status.
- `PaymentOrder` and `PaymentOrderItem` represent the online payment order introduced in Stage 10E-A.
- `PaymentRecord` and `PaymentWriteOff` remain the finance source of truth for collection and bill settlement.
- `DepositLedger` records deposit collect, freeze, deduct, refund, and release movements.
- `OrderEntitlementAccount`, `OrderEntitlementGrant`, and `OrderEntitlementUsage` store entitlement balances and usage.

All customer-facing views are derived from existing records. Stage 10F does not change the账务核销 path.

## 3. Portal APIs

New protected APIs:

- `GET /api/portal/orders`
- `GET /api/portal/orders/:id`
- `GET /api/portal/bills`
- `GET /api/portal/bills/:id`
- `GET /api/portal/payment-orders`
- `GET /api/portal/deposit`
- `GET /api/portal/deposit/transactions`
- `GET /api/portal/entitlements`
- `GET /api/portal/entitlements/usages`

Existing reused payment APIs:

- `POST /api/portal/payment-orders`
- `GET /api/portal/payment-orders/:id`
- `POST /api/portal/payment-orders/:id/pay`

All APIs are guarded by `CustomerAuthGuard`.

## 4. My Orders

Order list returns customer-owned orders only:

- `orderId`, `orderNo`, `orderStatus`.
- Redacted vehicle summary.
- Subscription plan summary.
- Current contract status.
- Derived payment status.
- Delivery status and actual delivery time.

Order detail aggregates:

- Order summary.
- Vehicle summary.
- Subscription plan summary.
- Contract summary.
- Bill summary.
- Deposit summary.
- Entitlement summary.
- Next action: `SIGN_CONTRACT`, `PAY_BILL`, `WAIT_DELIVERY`, `VIEW_ENTITLEMENTS`, or `NONE`.

The order detail page can route customers to contract signing, bill payment, all bills, and entitlements.

## 5. My Bills

Bill list supports filters:

- `billStatus`
- `billType`
- `orderId`
- pagination

Customer-visible fields:

- Bill number, type, status.
- Order number.
- Amount, paid amount, remaining amount.
- Due date and bill period.
- `canPay`, derived from remaining amount and payable statuses.

Bill detail includes:

- The bill summary.
- Related online payment orders.
- Related write-off records and payment records.

Unpaid or partially paid bills reuse Stage 10E payment order creation instead of creating a separate payment flow.

## 6. Payment Orders

Stage 10F adds the missing payment order list:

- `GET /api/portal/payment-orders`

It returns only the current customer's `PaymentOrder` records with items, status, channel, provider, amount, paid amount, payment record, and payment time.

The existing payment order detail page remains the canonical cashier/status page.

## 7. Deposit

Deposit overview is computed from confirmed `DepositLedger` rows owned by the current customer.

Returned totals:

- `totalCollectedAmount`
- `totalDeductedAmount`
- `totalRefundedAmount`
- `totalFrozenAmount`
- `availableAmount`

Account rows are grouped by order and include collected, deducted, refunded, frozen, remaining amount, and last transaction time.

Transaction list supports:

- `orderId`
- `transactionType`
- pagination

Customers cannot modify deposit records in this stage.

## 8. Entitlements

Entitlement grant list returns only grants owned by the current customer:

- Order number.
- Grant number.
- Entitlement type and name.
- Total, used, and remaining amount.
- Unit, source, status.
- Valid period.
- Latest usage time.

`TEXT` entitlements are displayed as descriptive benefits and do not expose numeric balances.

Usage list returns only customer-owned usage records:

- Usage number.
- Grant name.
- Amount and unit.
- Status and source.
- Occurred time.

Customers cannot consume or adjust entitlements in this stage.

## 9. H5 Pages

New Portal pages:

- `/portal/orders`
- `/portal/orders/[id]`
- `/portal/bills`
- `/portal/bills/[id]`
- `/portal/payment-orders`
- `/portal/deposit`
- `/portal/entitlements`

Updated Portal home:

- My orders, bills, payment records, deposit, and entitlements now link to real pages.
- Accident report and rescue request remain "coming soon" for Stage 10G.

## 10. Data Isolation and Redaction

Every new Portal API enforces `currentCustomer.customerId` ownership.

Customers cannot view:

- Other customers' orders.
- Other customers' bills.
- Other customers' payment orders.
- Other customers' deposit ledger.
- Other customers' entitlement grants or usages.

The Portal responses do not expose:

- `purchasePriceAmount`
- `currentSalePriceAmount`
- financing/capital structure fields
- residual/cost fields
- full VIN
- full plate number
- internal review comments
- back-office operator sensitive information

## 11. Relationship with Stage 10E Payment

Stage 10F does not create a new payment provider.

When a customer clicks "pay" on a bill or order detail page, the H5 page calls the existing Stage 10E endpoint:

- `POST /api/portal/payment-orders`

Then it redirects to:

- `/portal/payment-orders/:id`

Payment completion still flows through `PaymentOrder -> PaymentRecord -> PaymentWriteOff -> ReceivableBill`, and deposit collection remains handled by existing finance logic.

## 12. Not Included

Not included in Stage 10F:

- New payment providers.
- WeChat payment logic changes.
- Refunds.
- Invoices.
- Automatic debit.
- Finance write-off changes.
- Bill generation changes.
- Deposit ledger write changes.
- Entitlement grant, renewal, or consumption changes.
- Customer self-service entitlement usage.
- Accident report.
- Rescue request.
- WeChat notification center.
- WeChat H5 payment fallback outside WeChat.
- Production deployment.

## 13. Verification

Added tests:

- `apps/api/test/portal-order-billing.spec.ts`
- Updated `apps/api/test/portal-payment.spec.ts`

Coverage includes:

- Customer order ownership and sensitive field redaction.
- Customer bill ownership and `canPay` calculation.
- Cross-customer bill detail denial.
- Deposit overview ownership and totals.
- Entitlement grants and usage ownership.
- Payment order list ownership.
