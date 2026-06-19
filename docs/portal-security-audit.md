# Customer Portal Security Audit

## Scope

This audit covers customer-facing Portal H5 routes and `/api/portal/*` APIs for Stage 10I release hardening.

Stage 10H-B real template-message validation has passed. The remaining Stage 10J release-candidate concern is deployment readiness: the production H5 domain must serve the latest Portal routes before customer rollout.

## Route Inventory

Public or pre-login routes:

- `/portal/login`
- `/portal/terms`
- `/portal/privacy`
- `/portal/catalog`
- `/portal/catalog/[id]`

Customer routes that require a valid `customer_access_token` session at the API layer:

- `/portal`
- `/portal/me`
- `/portal/applications`
- `/portal/applications/[id]`
- `/portal/contracts`
- `/portal/contracts/[id]`
- `/portal/contracts/[id]/sign`
- `/portal/payment-orders`
- `/portal/payment-orders/[id]`
- `/portal/bills`
- `/portal/bills/[id]`
- `/portal/orders`
- `/portal/orders/[id]`
- `/portal/deposit`
- `/portal/entitlements`
- `/portal/service-cases`
- `/portal/service-cases/new`
- `/portal/service-cases/[id]`
- `/portal/notifications`

## API Boundary

Public APIs:

- `GET /api/portal/catalog/vehicles`
- `GET /api/portal/catalog/vehicles/:id`
- `GET /api/portal/catalog/subscription-plans`
- `GET /api/portal/catalog/vehicles/:id/subscription-plans`
- `POST /api/portal/auth/request-code`
- `POST /api/portal/auth/login`

Protected APIs use `CustomerAuthGuard`:

- `GET /api/portal/auth/me`
- `GET /api/portal/me`
- `POST /api/portal/auth/logout`
- `POST /api/portal/self-service-applications`
- `GET /api/portal/applications*`
- `GET /api/portal/contracts*`
- `GET /api/portal/payment*`
- `GET /api/portal/orders*`
- `GET /api/portal/bills*`
- `GET /api/portal/deposit*`
- `GET /api/portal/entitlements*`
- `GET|POST /api/portal/service-cases*`
- `GET|POST /api/portal/notifications*`

Back-office `access_token` and customer `customer_access_token` are separate. Admin JWTs must not grant access to protected portal APIs unless they also carry a valid customer session, which they should not.

## Ownership Rules

Every protected Portal query must derive `customerId` from `CurrentPortalCustomer`, not from request body or query params.

Ownership filters must apply to:

- Application list/detail/materials/final plan.
- Contract list/detail/sign task.
- Payment order list/detail/pay/mock-pay.
- Order list/detail.
- Bill list/detail.
- Deposit overview and transactions.
- Entitlements and usage records.
- Service case list/detail/attachments/cancel.
- Notification list/detail/read operations.

Existing tests cover customer isolation for applications, contracts/e-sign, payment, billing/entitlements, service cases, and notifications. Stage 10I smoke scripts add route/API launch checks, but they do not replace ownership unit tests.

## Response Redaction

Portal responses must not expose internal or sensitive fields unless explicitly designed for the customer:

- `purchasePriceAmount`
- `currentSalePriceAmount`
- Financing cost, debt, capital, ROE, residual forecast internals.
- Internal sales, risk, finance, service, or collection remarks.
- Full VIN.
- Full plate number before business approval to show it.
- Storage bucket, object key, local file path, OSS public URL internals.
- WeChat Pay certificate, API v3 key, callback verification details, or provider secrets.
- WeChat Official Account AppSecret, access_token, full openid, or full template ID.

Customer-facing vehicle snapshots currently use display names and allowed catalog fields. File previews stream through ownership-checked API endpoints instead of exposing storage internals.

## File Access

Material and service-case attachment preview endpoints must verify both:

- The current customer owns the parent application or service case.
- The requested file belongs to that parent object.

The API should stream the file with safe content headers and must not return raw OSS bucket/key values.

## Error Posture

Portal H5 should show readable Chinese error messages for:

- Not logged in.
- Empty data.
- Load failure.
- No permission or ownership mismatch.
- File not found.
- Payment failure.
- Signing failure.
- Application cancellation.
- Closed service cases.

Do not expose stack traces, raw database errors, provider secrets, or `Internal Server Error` text to customers.

## Smoke Commands

Route smoke:

```powershell
pnpm portal:route-smoke
```

API smoke:

```powershell
pnpm portal:api-smoke
```

Authenticated API smoke can use an existing customer cookie:

```powershell
$env:PORTAL_CUSTOMER_COOKIE="customer_access_token=<masked-token>"
pnpm portal:api-smoke
```

## Open Items Before Release

- Re-run route smoke against production H5 domain after deploying the latest Web image; the 2026-06-20 RC run returned 404 for `/portal/terms`, `/portal/privacy`, and `/portal/notifications`.
- Public API smoke against production API domain passed on 2026-06-20.
- Run authenticated API smoke with a controlled customer test account.
- Replace `/portal/terms` and `/portal/privacy` placeholder text with legal-approved versions.
- Keep WeChat Official Account menu apply behind explicit manual confirmation plus `WECHAT_MENU_APPLY=1`.
