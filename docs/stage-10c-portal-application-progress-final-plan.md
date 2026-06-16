# Stage 10C Portal Application Progress and Final Plan Confirmation

> Date: 2026-06-16  
> Branch: `feature/stage10-portal-application-progress-final-plan`  
> Scope: customer application progress, material supplement hints, final plan display, customer confirm/reject.

## 1. Goal

Stage 10C moves the A-line portal from "customer submitted a SELF_SERVICE Application" to "customer can track review progress and complete second confirmation after back office generates the final plan".

The A-line rule remains unchanged:

- Customer first action is "提交审核".
- Submission creates `SELF_SERVICE Application`.
- It does not directly create `SubscriptionOrder`.
- It does not create contracts, bills, or payments.
- Customer can only select active preset `SubscriptionPlan`.
- Deposit is pending at submission and finalized by review.
- Final plan must be shown to the customer for second confirmation.

This stage does not implement e-sign, payment, bills/entitlements, accident/rescue, WeChat OAuth, or real SMS.

## 2. Progress Timeline

New protected API:

- `GET /api/portal/applications/:id/progress`

Guard:

- `CustomerAuthGuard`

Ownership:

- The API always filters by `currentCustomer.customerId`.
- Other customers' applications return not found.
- Back-office admin tokens are not customer tokens and cannot satisfy `CustomerAuthGuard`.

Timeline step keys:

- `SUBMITTED`
- `MATERIAL_REVIEW`
- `CREDIT_REVIEW`
- `DEPOSIT_CONFIRM`
- `PRODUCT_REVIEW`
- `VEHICLE_REVIEW`
- `FINAL_PLAN`
- `CONTRACT`
- `PAYMENT`
- `DELIVERY`
- `ACTIVE`
- `CANCELLED`
- `REJECTED`

Step status values:

- `DONE`
- `CURRENT`
- `PENDING`
- `FAILED`

`nextAction` values currently used:

- `WAIT_REVIEW`
- `UPLOAD_MATERIAL`
- `CONFIRM_FINAL_PLAN`
- `REJECTED`
- `CANCELLED`
- `GO_CONTRACT_PENDING_BACKOFFICE`
- `GO_CONTRACT`
- `GO_PAYMENT`
- `WAIT_DELIVERY`

Stage 10C actively handles `WAIT_REVIEW`, `UPLOAD_MATERIAL`, `CONFIRM_FINAL_PLAN`, `REJECTED`, and `CANCELLED`. Contract/payment/delivery actions are placeholders for later stages.

## 3. Material Supplement Hints

The progress API returns `materialSupplementHints` when an application or material group enters supplement-needed status.

Returned fields are customer-safe:

- material group id
- material type
- material display name
- customer-facing review comment or generic supplement message

Internal operator notes and audit logs are not exposed.

## 4. Final Plan Query

New protected API:

- `GET /api/portal/applications/:id/final-plan`

If the final plan is not ready, the API returns:

```json
{
  "finalPlanStatus": "NOT_READY"
}
```

When ready, the response includes:

- application id/no
- final plan status
- customer-safe vehicle summary
- subscription plan summary
- pricing in cents
- customer-facing change notes
- important notes

Returned vehicle fields are intentionally redacted:

- brand
- series
- model
- model year
- battery capacity/type
- current mileage
- city
- display name

Not returned:

- full VIN
- full plate number
- purchase price
- current sale price
- capital/financing/residual internals
- sale-price review fields
- internal review notes

## 5. Customer Confirmation

New protected API:

- `POST /api/portal/applications/:id/final-plan/confirm`

Rules:

- Only the owning customer can confirm.
- Application must be `SELF_SERVICE`.
- Final plan must already exist.
- Application must be `APPROVED`.
- Deposit must be `CONFIRMED`.
- `finalDepositAmount` must exist.
- `planConfirmStatus` must be `PENDING`.
- Existing formal orders block confirmation.
- Duplicate confirmation is rejected.

On success:

- `planConfirmStatus = CONFIRMED`
- `finalPlanConfirmedAt` is written
- final plan/quote snapshots receive a `customerDecision` record
- application action log records "客户确认最终方案"
- portal audit log records the customer account operator

## 6. Customer Rejection

New protected API:

- `POST /api/portal/applications/:id/final-plan/reject`

Request:

```json
{
  "reason": "押金过高，暂不接受"
}
```

Rules:

- Only the owning customer can reject.
- Final plan must be in pending customer confirmation state.
- Reason is required.
- Rejection does not create order, contract, bill, or payment.

On success:

- `planConfirmStatus = REJECTED`
- `rejectedReason` is written
- final plan/quote snapshots receive a `customerDecision` record
- application action log records "客户拒绝最终方案"
- portal audit log records the customer account operator

The application `status` remains `APPROVED` so the back office can revise or regenerate the final plan. The vehicle remains in the review-reserved path for back-office rework rather than being released by the portal rejection action.

## 7. Quote / Order Creation Choice

Stage 10C adopts Strategy B:

- Customer confirmation records `planConfirmStatus = CONFIRMED`.
- It does not automatically call `CustomerService.createOrderFromApplication`.
- Back office then uses the existing order creation action after customer confirmation.

Reason:

- Existing order creation already creates quote and `SubscriptionOrder`, transitions the vehicle to `RESERVED`, and guards duplicate orders.
- Keeping it as a back-office action in Stage 10C avoids accidental duplicate order creation from a customer endpoint.
- Later stages can safely automate this once an idempotent portal-facing order orchestration layer is added.

The confirm API returns `nextAction = GO_CONTRACT_PENDING_BACKOFFICE`.

## 8. H5 Page

Enhanced route:

- `/portal/applications/[id]`

Added:

- Progress timeline.
- `nextAction` prompt.
- Material supplement hints.
- Final plan card.
- "确认最终方案" button.
- "暂不接受方案" button with required reason.
- Confirmed-state message: "已确认最终方案，等待合同签署".

Still not shown:

- full VIN
- full plate
- purchase price
- current sale price
- financing/capital/residual data
- internal review notes

## 9. Back-office Alignment

`CustomerService.finalizeApplicationPlan` now means "generate final plan and wait for customer confirmation" for the A-line flow:

- `finalPlanSnapshot` is written.
- `finalQuoteSnapshot` is written.
- application status becomes `APPROVED`.
- product/vehicle reviews are auto-approved as before.
- `planConfirmStatus = PENDING`.
- `finalPlanConfirmedAt = null`.

Formal order creation remains blocked until customer confirmation sets `planConfirmStatus = CONFIRMED`.

## 10. Security Boundary

All Stage 10C portal APIs use `CustomerAuthGuard` and `currentCustomer.customerId` ownership checks.

Protected resources:

- application progress
- final plan view
- final plan confirm
- final plan reject

The portal continues to use `/api/portal/*` and does not expose back-office `/api/applications/*` directly.

## 11. Tests

Added or updated coverage:

- Back-office final plan generation now leaves `planConfirmStatus = PENDING`.
- Customer can get own progress.
- Customer cannot get another customer's progress.
- Final plan returns `NOT_READY` before generation.
- Final plan ready response does not expose full VIN, full plate, purchase price, or current sale price.
- Customer can confirm own final plan.
- Duplicate confirmation fails.
- Customer cannot confirm another customer's final plan.
- Customer rejection records reason.
- Rejection does not create a formal order.
- Confirmation uses Strategy B and does not create quote/order automatically.

## 12. Deferred Items

Deferred to Stage 10D+:

- e-sign provider abstraction and signing links
- contract signing callback
- contract evidence archive
- WeChat Pay
- customer bill/deposit/entitlement center
- accident report and rescue service cases
- WeChat OAuth and service account notification
- real SMS provider
- automatic quote/order orchestration from the portal

## 13. Next Stage

Recommended next stage:

- Stage 10D: electronic signature.

After customer final plan confirmation, the next customer-facing action is contract signing. Payment should connect after signing or after the signed-contract pending-payment state is defined.
