# Stage 10E-A Payment Foundation

> Date: 2026-06-16  
> Branch: `feature/stage10-payment-foundation`  
> Scope: portal payment orders, payment provider abstraction, mock payment loop, automatic finance write-off.

## 1. Goal

Stage 10E-A adds the customer-side online payment foundation after contract signing.

This stage intentionally does not connect real WeChat Pay. It introduces the payment order boundary, provider interface, mock provider, callback log, and Portal payment pages so the customer journey can complete a test payment loop.

## 2. Existing Finance Baseline

Current finance capability is implemented in `apps/api/src/finance`.

Existing reusable behavior:

- `ReceivableBill` stores bill amount, paid amount, remaining amount, bill status, due date, and bill type.
- `PaymentRecord` is the collection record used by back-office finance.
- `PaymentWriteOff` confirms how a collection is allocated to receivable bills.
- `DepositLedger` records confirmed deposit collection, deduction, release, and refund movements.
- `FinanceService.createPayment` validates order/customer scope and creates a confirmed collection record.
- `FinanceService.writeOffPayment` updates bill `paidAmount`, `remainingAmount`, and `billStatus`; it also creates a confirmed `DepositLedger.COLLECT` when a deposit bill becomes fully paid.

Reporting keeps its existing rule: `PaymentRecord` is not revenue by itself. Realized revenue and bill settlement are driven by `PaymentWriteOff` and `ReceivableBill` updates.

## 3. Data Model

New models:

- `PaymentOrder`
- `PaymentOrderItem`
- `PaymentCallbackLog`

New enums:

- `PaymentProviderType`: `MOCK`, `WECHAT_PAY`, `ALIPAY`, `BANK_TRANSFER`, `OTHER`
- `PaymentChannel`: `MOCK`, `WECHAT_JSAPI`, `WECHAT_H5`, `ALIPAY_H5`, `BANK_TRANSFER`
- `PaymentOrderStatus`: `CREATED`, `PENDING`, `PAID`, `FAILED`, `CLOSED`, `CANCELLED`, `EXPIRED`

Migration:

- `20260616223000_portal_payment_orders`

`PaymentOrder.paymentRecordId` is optional and filled only after payment succeeds and the existing finance collection record is created.

## 4. Provider Boundary

New module:

- `apps/api/src/payment`

Provider interface supports:

- `createPayment`
- `verifyCallback`

Current provider:

- `MockPaymentProvider`

The provider is selected by `PAYMENT_PROVIDER`. Stage 10E-A only wires `mock`; real WeChat Pay is reserved for Stage 10E-B.

## 5. Mock Provider

Mock behavior:

- Creates provider trade no as `mock_<paymentOrderNo>`.
- Generates a Portal mock cashier URL.
- Does not call external APIs.
- Allows `POST /api/portal/payment-orders/:id/mock-pay` only when:
  - `PAYMENT_PROVIDER=mock`
  - `PAYMENT_MOCK_ENABLED=true`

Production examples keep mock disabled by default.

## 5.1 Stage 10E-B Update

Stage 10E-B adds `WECHAT_JSAPI` support through `WeChatPayProvider`.

Additional capabilities:

- Minimal WeChat openid binding for logged-in Portal customers.
- WeChat Pay API v3 JSAPI prepay creation.
- JSAPI frontend parameters for `WeixinJSBridge`.
- WeChat callback signature verification and encrypted resource decryption.
- Callback paid handling reuses the same `PaymentOrder` completion path introduced in Stage 10E-A.

WeChat browser H5 fallback remains deferred to Stage 10E-C.

## 6. Portal APIs

Protected Portal APIs:

- `GET /api/portal/payment/payable-bills`
- `POST /api/portal/payment-orders`
- `GET /api/portal/payment-orders/:id`
- `POST /api/portal/payment-orders/:id/pay`
- `POST /api/portal/payment-orders/:id/mock-pay`

Public callback endpoint:

- `POST /api/payments/callback/:provider`

Guard:

- `CustomerAuthGuard`

Ownership:

- Portal payable bills are filtered by `currentCustomer.customerId`.
- Payment orders can only be created from bills owned by the current customer.
- Payment order detail, payment start, and mock-pay all enforce current-customer ownership.
- Admin tokens cannot satisfy customer portal auth.

## 7. Payment Order Rules

Payment order creation:

- Requires at least one bill.
- Only `PENDING`, `PARTIALLY_PAID`, and `OVERDUE` bills with `remainingAmount > 0` can be paid.
- A single `PaymentOrder` currently covers bills under one order.
- Amount equals the sum of bill `remainingAmount`.
- Existing pending payment order for the same customer and same bill set is reused when possible.
- Paid bills cannot create a new payment order because their remaining amount is zero.

Stage 10E-A uses `PaymentChannel.MOCK`; real `WECHAT_JSAPI` or `WECHAT_H5` is not yet enabled.

## 8. Payment Completion Effects

Mock payment and paid callbacks:

- Mark `PaymentOrder.paymentStatus = PAID`.
- Write `paidAt`, `paidAmount`, and mock provider transaction id.
- Create `PaymentCallbackLog` and handle it idempotently.
- Create a `PaymentRecord` through `FinanceService.createPayment`.
- Call `FinanceService.writeOffPayment` for all payment order items.
- Update related `ReceivableBill` paid/remaining/status through the existing finance service.
- Create `DepositLedger.COLLECT` through the existing finance service when a deposit bill is fully paid.

Order status is not directly advanced by Stage 10E-A. The existing delivery preparation flow still owns the transition from `PENDING_PAYMENT` to `PENDING_DELIVERY` after operational checks are satisfied.

## 9. H5 Pages

New Portal routes:

- `/portal/payment-orders/[id]`
- `/portal/payment-orders/[id]/mock-pay`

Enhanced route:

- `/portal/contracts/[id]` shows a payment entry when the contract is signed and the order is `PENDING_PAYMENT`.

The mock payment page clearly states that it is only for testing and that real WeChat Pay will redirect to a real cashier page after Stage 10E-B.

## 10. Not In Scope

This stage does not implement:

- Real WeChat Pay merchant API.
- WeChat certificates, API v3 key, JSAPI OpenID payment, or H5 payment signing.
- Alipay, bank cards, automatic debit, refunds, invoices.
- Changes to bill generation, pricing, or quote formulas.
- Rewriting finance write-off or deposit ledger logic.
- Production deployment.

## 11. Next Stage

Recommended next stage:

- Stage 10E-B: real WeChat Pay provider, callback signature verification, merchant configuration, JSAPI/H5 channel support.

If WeChat Pay merchant material is not ready, Stage 10F can proceed with customer bill/deposit/entitlement center using the PaymentOrder and finance records created here.
