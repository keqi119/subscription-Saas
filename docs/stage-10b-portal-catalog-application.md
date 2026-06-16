# Stage 10B Portal Catalog and Self-service Application

> Date: 2026-06-16  
> Branch: `feature/stage10-portal-catalog-application`  
> Scope: customer-facing catalog, SELF_SERVICE application submission, material upload, and application progress.

## 1. Goal

Stage 10B builds the first customer-side A-line business loop on top of Stage 10A:

- Guests can browse customer-safe available vehicles.
- Guests can view active preset `SubscriptionPlan` options.
- Logged-in customers can submit "提交审核".
- Submission creates `SELF_SERVICE Application`, not a formal order.
- Customers can view only their own application list/detail.
- Customers can upload application materials through private storage.
- Customers can cancel their own mutable pending application.

This stage does not implement final plan confirmation, e-sign, online payment, bills, entitlements, accident report, rescue, real WeChat OAuth, or real SMS provider.

## 2. Catalog API

New public APIs:

- `GET /api/portal/catalog/vehicles`
- `GET /api/portal/catalog/vehicles/:id`
- `GET /api/portal/catalog/subscription-plans`
- `GET /api/portal/catalog/vehicles/:id/subscription-plans`

Catalog browsing is intentionally public and does not use `CustomerAuthGuard`.

Vehicle visibility rules:

- `deletedAt = null`
- `status = AVAILABLE`
- `salePriceStatus = EFFECTIVE`
- `currentSalePriceAmount > 0`

Customer-visible vehicle fields:

- `id`
- `brand`
- `series`
- `model`
- `modelYear`
- `batteryCapacityKwh`
- `batteryUsageType`
- `currentMileageKm`
- `city`
- `coverImageUrl`
- `gallery`
- `displayName`
- `tags`
- `statusLabel`
- `available`

Not exposed:

- `purchasePriceAmount`
- full `vin`
- full `plateNo`
- `currentSalePriceAmount`
- capital structure
- financing allocations
- residual valuation internals
- sale-price review internals

The current schema has no customer-facing vehicle image/gallery publishing model. Stage 10B returns `coverImageUrl = null` and `gallery = []`; product image publishing should be added later.

## 3. SubscriptionPlan Display

Customer-side selection is limited to preset active `SubscriptionPlan`. The portal does not expose free composition of:

- `VehiclePackage`
- `MileagePackage`
- `EnergyPackage`
- `BenefitPackage`

Visible plan fields:

- `planId`
- `planNo`
- `planName`
- `subscriptionPeriodRange`
- `periodOptions`
- `monthlyFeeAmount`
- `monthlyFeeDescription`
- `depositDescription`
- `mileageDescription`
- `energyDescription`
- `benefitDescription`
- `packageSummary`
- `canSubmit`

Manual-quote plans may be visible as active plans, but are marked `canSubmit = false`. Actual self-service submission still reuses the existing domain validation and rejects unsupported manual-quote plans.

## 4. Self-service Application API

New protected API:

- `POST /api/portal/self-service-applications`

Guard:

- `CustomerAuthGuard`

Request:

```json
{
  "vehicleId": "...",
  "subscriptionPlanId": "...",
  "subscriptionPeriodMonths": 12,
  "remark": "客户从 H5 提交"
}
```

Behavior:

- Derives `customerId` from the customer token.
- Resolves an internal service owner because the current `Application.salesUserId` is a required relation to back-office `User`.
- Owner resolution order: `Customer.ownerUserId`, optional `PORTAL_APPLICATION_OWNER_USER_ID`, then the first active back-office user as a development/staging fallback.
- Reuses the existing `CustomerService.createSelfServiceApplication` domain logic.
- Validates available vehicle and active plan.
- Creates `Application` with `applicationSource = SELF_SERVICE`.
- Writes intent snapshots.
- Sets `depositStatus = PENDING_CONFIRM`.
- Sets `finalDepositAmount = null`.
- Moves vehicle to `REVIEW_RESERVED`.
- Writes audit records.
- Returns customer-safe identifiers/status.

It does not create:

- `SubscriptionOrder`
- `Contract`
- `ReceivableBill`
- `PaymentRecord`
- `PaymentOrder`

## 5. Application Progress API

New protected APIs:

- `GET /api/portal/applications`
- `GET /api/portal/applications/:id`
- `POST /api/portal/applications/:id/cancel`

Rules:

- All use `CustomerAuthGuard`.
- All filter by `currentCustomer.customerId`.
- Only `SELF_SERVICE` applications are returned.
- Other customers' applications return not found.
- The response does not return raw `intentSnapshot`, full VIN, full plate, or internal review comments.
- Customer cancellation is limited to mutable pending states and applications without formal orders.
- Cancellation reuses the back-office cancellation logic so the soft-reserved vehicle is released safely.

Stage 10B intentionally does not implement customer final plan confirmation. That belongs to Stage 10C.

## 6. Material Upload and Preview

New protected APIs:

- `POST /api/portal/applications/:id/materials`
- `GET /api/portal/applications/:id/materials`
- `GET /api/portal/applications/:id/materials/:materialId/preview`

Rules:

- Customers can upload only to their own application.
- Upload reuses `StorageService.putApplicationMaterial`.
- Local and OSS drivers remain supported.
- The portal response does not expose `bucket`, `objectKey`, or public OSS URL.
- Preview streams through the API after customer ownership verification.
- File records use the current application's internal `salesUserId` for existing `User` foreign-key fields, while portal audit records store the customer account as the portal operator.

## 7. H5 Routes

New customer H5 pages:

- `/portal/catalog`
- `/portal/catalog/[id]`
- `/portal/applications`
- `/portal/applications/[id]`

Updated:

- `/portal` now links to catalog and applications.
- `/portal/login` supports `redirect=/portal/...` after successful login.

Page behavior:

- Catalog and catalog detail are guest-accessible.
- Submit, applications, material upload, preview, and cancel require login.
- If protected APIs return 401, the H5 redirects to `/portal/login?redirect=...`.

## 8. Security Boundary

Security rules introduced or reinforced:

- Public catalog returns redacted DTOs only.
- Protected portal APIs use `CustomerAuthGuard`.
- Customer identity is derived from `customer_access_token`, not request body.
- Portal APIs do not accept arbitrary `customerId`.
- Application list/detail/cancel/upload/preview are filtered by `currentCustomer.customerId`.
- Back-office RBAC APIs remain separate and are not exposed to the H5 portal.
- File preview streams through API ownership checks.
- OSS public URLs remain hidden.

## 9. Tests

Added coverage:

- Public catalog redacts internal vehicle fields.
- Active plan display calculates a customer-safe estimated monthly fee.
- Portal submit calls self-service application logic with the current customer.
- Portal submit response does not include order data.
- Customers cannot read another customer's application.
- Customers cannot upload materials to another customer's application.
- Material upload uses `StorageService`.
- Material responses do not expose bucket/object keys.
- Material preview checks customer ownership.
- Customer cancellation uses the application sales owner and returns the updated portal view.
- Approved applications cannot be cancelled from the portal.

## 10. Deferred Items

Deferred to later stages:

- Product image/gallery publishing model.
- Dedicated customer publish status beyond available vehicle rules.
- Customer final plan confirm/reject flow.
- E-sign provider abstraction and signing callbacks.
- WeChat Pay prepay/callback/idempotency/write-off.
- Customer bills, deposit, and entitlements.
- Accident report and rescue service cases.
- Real WeChat OAuth and service account menu/messages.
- Real SMS provider and notification retry center.

## 11. Next Stage

Recommended next stage:

- Stage 10C: application progress refinement and customer final plan confirmation.

Stage 10C should add customer confirmation/rejection of the final audited plan before any formal order, contract, or payment flow is allowed.
