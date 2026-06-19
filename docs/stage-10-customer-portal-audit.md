# Stage 10.0 Customer Portal / A-line Online Journey Audit

> Audit date: 2026-06-16  
> Branch: `feature/stage10-customer-portal-audit`  
> Scope: read-only takeover audit for the customer portal and A-line online journey.  
> Boundary: no business code, Prisma schema, migration, seed, production configuration, or existing API behavior was changed.

## 1. Background and Goal

The production back office is already online:

- Web: `https://admin.subauto.keybox.cloud`
- API health: `https://api.subauto.keybox.cloud/api/health`
- Storage: OSS-backed private object storage

Stage 10 extends the system from an internal operation console to a customer-facing A-line online subscription journey. The confirmed first version is H5 plus WeChat service account entry, using `app.subauto.keybox.cloud` as the default customer domain. Native mini-program and enterprise customer journeys are out of scope for the first release.

This audit checks whether existing code can support:

- Guest product browsing.
- Login before application submission.
- SMS code login and WeChat OAuth binding.
- Customer-side self-service application submission.
- Material upload.
- Application progress and final plan confirmation.
- Contract signing.
- WeChat Pay for deposit, first monthly rent, and monthly bills.
- Customer order, bill, deposit, and entitlement center.
- Accident report and rescue request.
- WeChat service account notification.

The conclusion is that the back-office foundation is reusable, but the production customer portal is not yet closed-loop. Stage 10 must add a separate customer account/auth boundary, redacted portal APIs, portal H5 routes, payment/e-sign provider abstractions, service case foundation, and notification center.

## 2. Current Reusable Back-office Capabilities

The following current modules are reusable as domain foundations:

| Area | Reusable capability | Current boundary |
| --- | --- | --- |
| Customer and application | `Customer`, `Application`, A/B application workflow, review statuses, action logs | Back-office `User` + RBAC only |
| A-line self service | `POST /api/self-service-applications` creates `SELF_SERVICE Application` and does not create a formal order | Back-office guarded; not a customer portal API |
| Product packages | `Product`, `ProductVersion`, `VehiclePackage`, `MileagePackage`, `EnergyPackage`, `BenefitPackage`, `SubscriptionPlan` | Back-office management API |
| Vehicle availability | Available vehicle pool and `REVIEW_RESERVED` reservation state | Back-office DTO exposes sensitive fields |
| Materials | `StorageService`, local/OSS drivers, private object streaming through API | Back-office upload/download guards |
| Final plan | Application final plan snapshot and order creation after review | Operator confirms directly; no customer second confirmation |
| Orders/contracts | `SubscriptionOrder`, contract template/version, contract generation/status | Manual back-office signing/archiving |
| Billing/payment records | `ReceivableBill`, `PaymentRecord`, `PaymentWriteOff`, `DepositLedger` | Manual collection/write-off; no online payment order |
| Entitlements | `OrderEntitlementAccount`, grants, usage records | Back-office order scoped APIs |
| Delivery/return/damage | Delivery, return, return damage records | Operational after-sales domain; not accident/rescue service cases |
| Collection | `CollectionCase`, bills, actions for overdue collections | Finance/collection domain; not general customer service cases |
| Reports | Finance, order, deposit, collection, asset, entitlement reporting | Internal aggregate reports only |
| OSS readiness | Private bucket, OSS adapter, API stream preview/download | Reusable if portal ownership checks are added |

## 3. Customer-side Gap Overview

The current codebase has no production-ready customer-side portal. The main gaps are:

- No H5 customer portal route group or public catalog route.
- No customer login page.
- No customer account model, customer JWT/session, SMS verification code, WeChat OpenID/UnionID binding, or customer auth guard.
- No redacted public vehicle/product catalog API.
- No `/api/portal/*` ownership-filtered API surface.
- No customer material upload/download with `customerId` ownership checks.
- No customer-facing application progress or final plan confirm/reject API.
- No electronic signature provider abstraction, signing link, callback, evidence archive, or customer contract download.
- No `PaymentOrder`, WeChat Pay prepay, callback signature verification, idempotent notification handling, auto write-off, or customer payment page.
- No customer "my orders", "my bills", "my deposit", or "my entitlements" portal APIs.
- No accident report, rescue request, or general service work-order base.
- No WeChat service account OAuth/menu/template-message module.
- No SMS provider or notification outbox/retry center.

## 4. A-line Online Order Definition

The mainline documentation defines A-line as customer self-service application first, not direct formal order creation:

- A-line equals `SELF_SERVICE Application`.
- The customer-facing button copy must be "提交审核", not "立即下单".
- Customer side can only select preset active `SubscriptionPlan`.
- Customer side must not freely compose `VehiclePackage`, `MileagePackage`, `EnergyPackage`, or `BenefitPackage`.
- Customer submission only stores intent fields and snapshots.
- Deposit is pending at submission: `depositStatus = PENDING_CONFIRM`, `finalDepositAmount = null`.
- The formal `SubscriptionOrder` can only be generated after materials, credit, deposit, product, vehicle, and final plan are confirmed.
- If final vehicle, deposit, period, monthly rent, or package terms change, the customer must confirm again before contract/payment.

The current `POST /api/self-service-applications` implementation matches the key domain rule: it creates an application, records the selected intent, moves the vehicle to `REVIEW_RESERVED`, and does not create a `SubscriptionOrder`. However, it is still a back-office API and cannot be exposed directly to customers.

## 5. Client Shape Confirmation

Confirmed Stage 10 client shape:

- First version: H5 customer portal plus WeChat service account menu entry.
- Default domain: `app.subauto.keybox.cloud`.
- Guest users can browse published products/vehicles.
- Login is required before submitting an application or viewing personal data.
- Login methods: SMS code and WeChat OAuth.
- Payment channel first version: WeChat Pay.
- Payment scope first version: deposit, first monthly rent, and monthly rent bills.
- Customer bill/deposit/entitlement center is included in the first version.
- Accident report and rescue request are included in the first version.
- WeChat service account notification is included in the first version.
- SMS notification is P1.
- Enterprise customers are excluded from the first version.

## 6. Current Code Fact Audit

### 6.1 Documentation Constraints

Checked files:

- `DEV_SPEC.md`
- `CODEX_TASKS.md`
- `README.md`
- `docs/reporting-metrics.md`
- `docs/manual-acceptance.md`
- `docs/production-cutover-execution-report.md`

Key constraints found:

- A-line is a `SELF_SERVICE Application`, not a direct `SubscriptionOrder`.
- Formal order generation is after review and final confirmation.
- Customer copy uses "提交审核".
- Customer-facing selection is preset active `SubscriptionPlan` only.
- Component package free composition remains back-office/product-center controlled.
- Deposit is pending on submission and finalized after review.
- Production cutover has been recorded as completed, while customer-side portal remains outside the current production closed loop.

### 6.2 Frontend Routes

Checked `apps/web/src/app`.

Existing pages are internal console pages, including:

- `/login`
- `/`
- `/customers`
- `/applications`
- `/applications/[id]`
- `/quotes`
- `/quotes/[id]`
- `/orders`
- `/orders/[id]`
- `/orders/review`
- `/contracts`
- `/contracts/[id]`
- `/contract-versions`
- `/products`
- `/vehicles`
- `/vehicle-asset-pools`
- `/vehicle-valuation-reviews`
- `/billing/monthly-rent`
- `/billing/collections`
- `/reports`
- `/reports/asset-profitability`
- `/risk/deposit-rules`
- `/system/*`
- `/financing-instruments`
- `/residual-market`
- `/revenue-rights`

Not found:

- Customer H5 route group.
- Public product/vehicle listing page.
- Customer login page.
- Customer "my orders", "my bills", "my deposit", or "my entitlements" pages.
- WeChat service account callback/menu landing pages.

Conclusion: front-end patterns can be reused, but the current app is an admin console protected by back-office auth and RBAC. Customer portal pages should be added as a separate route surface.

### 6.3 Customer Auth and Account System

Checked:

- `apps/api/src/auth`
- `apps/api/src/customer`
- `packages/shared/src/auth.ts`
- `apps/api/prisma/schema.prisma`

Current state:

- Back-office login uses `User`, `Role`, `Permission`, username/password, JWT, and httpOnly `access_token` cookie.
- `Customer` is a business profile, not an auth account.
- `CustomerIdentity` exists for identity/driving-license data, but not for login.
- No `CustomerAccount` model.
- No customer JWT/session.
- No SMS verification code login.
- No WeChat OpenID/UnionID model or binding.
- No `CustomerAuthGuard`.
- No customer ownership guard/filter.
- No customer agreement, privacy consent, or authorization record.

Conclusion: customer account system is missing. Stage 10A must introduce it before customer-side application submission or personal data pages.

### 6.4 Self-service Application API

Checked:

- `apps/api/src/customer/customer.controller.ts`
- `apps/api/src/customer/customer.service.ts`
- `apps/api/test/*`
- `apps/api/prisma/schema.prisma`

Current facts:

- `POST /api/self-service-applications` exists.
- It is guarded by `AuthGuard` and `PermissionsGuard`.
- It requires `APPLICATION_MANAGE` or `APPLICATION_SUBMIT`.
- DTO requires `customerId`, `vehicleId`, `subscriptionPlanId`, and `periodMonths`.
- It loads the customer, vehicle, active subscription plan, and validates vehicle/model/period availability.
- It calculates base fee and monthly fee from the selected active plan and current sale price.
- It stores `intentSnapshot` and `customerSelectedSnapshot`.
- It creates `Application` with `applicationSource = SELF_SERVICE`.
- It sets review statuses to pending.
- It sets `depositStatus = PENDING_CONFIRM` and `finalDepositAmount = null`.
- It sets `planConfirmStatus = PENDING`.
- It moves vehicle `AVAILABLE -> REVIEW_RESERVED`.
- It does not create a formal `SubscriptionOrder`.

Risks if exposed directly:

- It requires a back-office token and permission.
- It accepts `customerId` from the request body rather than deriving it from the current customer session.
- `salesUserId` is derived from owner/back-office user context.
- Current application detail/cancel/material APIs are scoped for back-office users, not customer ownership.
- Snapshots may contain fields unsuitable for customer display unless redacted.

Recommendation: Stage 10B should create `/api/portal/self-service-applications`, deriving `customerId` from `CustomerAuthGuard`, validating published/redacted catalog IDs, and returning a customer-safe response.

### 6.5 Product and Vehicle Catalog

Checked:

- `apps/api/src/product`
- `apps/api/src/vehicle`
- `apps/api/src/report`
- `apps/web/src/app/products`
- `apps/web/src/app/vehicles`
- `apps/api/prisma/schema.prisma`

Current facts:

- Product, package, and `SubscriptionPlan` modules exist.
- Active subscription plan filtering exists for back-office quote/application usage.
- Available vehicle API exists at `GET /api/vehicles/available`.
- Product and vehicle controllers are guarded by back-office auth and permissions.
- Vehicle DTOs include sensitive/internal fields such as `purchasePriceAmount`, full `vin`, `plateNo`, `currentSalePriceAmount`, and internal status details.
- No customer-side publish/listing status was found.
- No vehicle cover/gallery image model was found.
- No public customer catalog API was found.
- No customer-safe catalog filters were found for city/brand/model.

Conclusion: Stage 10B can reuse active plan and availability rules, but must add customer-facing publish controls and redacted DTOs.

### 6.6 Material Upload and OSS

Checked:

- `apps/api/src/customer`
- `apps/api/src/storage`
- `docs/object-storage-readiness.md`

Current facts:

- Application material upload exists at `POST /api/applications/:id/materials`.
- Preview/download/delete endpoints exist.
- These endpoints are back-office guarded.
- Upload uses `StorageService`.
- `StorageService` supports local and OSS drivers.
- OSS is private storage and files are streamed through API rather than exposed by permanent public URL.

Reusable:

- Storage abstraction.
- OSS driver.
- File metadata and application material relation.
- API stream pattern for preview/download.

Missing for portal:

- Customer-authenticated material upload route.
- `customerId` ownership check for application and file.
- Customer-safe material type configuration.
- Rate limiting, file-size/type rules, and audit events for public upload.

### 6.7 Final Plan Confirmation

Current facts:

- Back office has `POST /api/applications/:id/finalize-plan`.
- `CustomerService.finalizeApplicationPlan` confirms the final plan directly as an operator action.
- It sets `finalPlanSnapshot`, final vehicle/plan/period/base fee, review statuses, `planConfirmStatus = CONFIRMED`, and application status `APPROVED`.
- There is no customer-facing final plan confirm/reject API.
- There is no customer-facing final plan page.
- Current back-office page explicitly treats this as temporary/manual acceptance behavior.

Conclusion: Stage 10C must split operator finalization from customer second confirmation. The customer must be able to view final terms, accept, or reject before order/contract progression.

### 6.8 Contract and E-sign

Checked:

- `apps/api/src/order`
- `apps/web/src/app/contracts`
- `apps/api/prisma/schema.prisma`
- `docs/manual-acceptance.md`

Current facts:

- Contract template/version and contract generation exist.
- `Contract` has snapshot, status, `signedAt`, `archivedAt`, and optional `fileId`.
- Signing is currently a back-office `signContract` status update.
- Archiving can attach a `fileId`.
- No e-sign provider abstraction was found.
- No signing task/link model was found.
- No callback endpoint was found.
- No signature evidence archive model was found.
- No customer contract download API/page was found.

Conclusion: Stage 10D needs an e-sign module boundary instead of exposing the existing manual sign endpoint.

### 6.9 Payment and Collection

Checked:

- `apps/api/src/finance`
- `apps/api/src/billing`
- `apps/api/src/payment`
- `apps/web/src/app/*`
- `apps/api/prisma/schema.prisma`

Current facts:

- `apps/api/src/payment` does not exist as a dedicated online payment module.
- `ReceivableBill`, `PaymentRecord`, `PaymentWriteOff`, and `DepositLedger` exist.
- Finance controller supports manual payment registration and write-off.
- `PaymentRecord.paymentStatus` defaults to `CONFIRMED`.
- No `PaymentOrder` model was found.
- No WeChat Pay prepay API was found.
- No WeChat Pay notify/callback signature verification was found.
- No payment idempotency model was found.
- No customer payment page was found.
- Refunds are manual/back-office oriented, not payment-channel integrated.

Conclusion: Stage 10E must add online payment order and provider layers, then connect successful payment callbacks to write-off and deposit ledger creation.

### 6.10 Customer Order, Bill, Deposit, and Entitlement Views

Checked:

- `apps/api/src/report`
- `apps/api/src/order`
- `apps/api/src/entitlement`
- `apps/api/src/billing`
- `apps/api/src/deposit`
- `apps/api/src/customer`

Current facts:

- Orders, bills, payments, deposit ledgers, and entitlement accounts/grants/usage exist.
- Existing APIs are back-office guarded and scoped by internal roles/sales ownership.
- Report APIs aggregate internal data and must not be exposed to customers.
- Entitlement records are already tied to `customerId` and `orderId`, which is reusable.
- No portal APIs were found for "my orders", "my bills", "my deposit", or "my entitlements".

Conclusion: Stage 10F should add ownership-filtered portal APIs and customer H5 pages.

### 6.11 Accident, Rescue, and Service Work Orders

Checked search terms:

- `accident`
- `rescue`
- `service case`
- `support case`
- `ticket`
- `work order`
- `repair`
- `maintenance`
- `damage`
- `VehicleReturnDamage`

Current facts:

- No general `ServiceCase` model was found.
- No accident report model/API was found.
- No rescue request model/API was found.
- No support ticket model/API was found.
- `VehicleReturnDamage` exists, but it is tied to return inspection and damage settlement.
- `CollectionCase` exists, but it is tied to overdue collection.
- Delivery/return/maintenance/damage fields exist for operational workflows.

Conclusion: Stage 10G needs a new unified `ServiceCase` foundation with accident and rescue case types. Return damage and collection cases are related domain references but should not be reused as customer service cases.

### 6.12 WeChat Service Account and Notification Center

Checked search terms:

- `wechat`
- `weixin`
- `openid`
- `unionid`
- `template message`
- `subscribe message`
- `sms`
- `notification`
- `notify`

Current facts:

- No WeChat OAuth module was found.
- No OpenID/UnionID binding was found.
- No service account menu configuration was found.
- No WeChat template-message sender was found.
- No notification template/log/outbox model was found.
- No SMS provider was found.
- No station-message/in-app message module was found.
- No notification retry mechanism was found.

Conclusion: Stage 10H must add the WeChat and notification foundation. SMS notification remains P1 unless Stage 10A needs SMS verification for login, which should be implemented as auth verification rather than broad notification.

## 7. Module Capability Matrix

| Module | Current state | Reusable | Gap | Stage |
| --- | --- | --- | --- | --- |
| Customer H5 portal | Missing | Admin UI patterns only | Portal route shell, mobile layout, navigation | 10A |
| Customer account | Missing | `Customer` profile | `CustomerAccount`, SMS auth, WeChat binding, customer token | 10A |
| Portal auth guard | Missing | Back-office guard style | `CustomerAuthGuard`, ownership helpers, portal cookie/token | 10A |
| Public catalog | Missing | Vehicle/product/plan services | Publish status, images, redacted DTOs, filters | 10B |
| Self-service application | Back-office API exists | Application workflow, snapshots, `REVIEW_RESERVED` | Portal submission API, customer ownership, safe response | 10B |
| Material upload | Back-office upload exists | Storage/OSS/private stream | Portal upload/download with ownership and upload config | 10B |
| Progress tracking | Back-office detail exists | Application statuses/logs | Customer progress DTO/page | 10C |
| Final plan confirmation | Operator direct confirm | Final plan snapshot | Customer accept/reject state and API | 10C |
| E-sign | Manual status update | Contract templates/snapshots/file archive | Provider abstraction, sign task, callback, evidence | 10D |
| Online payment | Manual payment/write-off | Bill/payment/write-off/deposit ledger | Payment order, WeChat Pay, notify, idempotency | 10E |
| Customer finance center | Missing | ReceivableBill/DepositLedger | Customer bill/deposit/payment pages and APIs | 10F |
| Entitlement center | Back-office order view | Entitlement account/grant/usage | Customer entitlement summaries and usage history | 10F |
| Accident report | Missing | Customer/order/vehicle/material relations | `ServiceCase` accident type, file attachments | 10G |
| Rescue request | Missing | Customer/order/vehicle/material relations | `ServiceCase` rescue type, dispatch/status flow | 10G |
| Notification | Missing | None substantial | WeChat OAuth/messages, notification outbox/log | 10H |
| SMS notification | Missing | None substantial | Provider and message templates | P1 after 10H, except login code |

## 8. P0 / P1 / P2 Gaps

### P0

- Customer account and portal auth boundary.
- SMS verification code login for customer auth.
- WeChat OAuth binding for service account entry.
- Portal route shell and customer login/session handling.
- Public product/vehicle catalog with publish controls, images, and redacted fields.
- Portal self-service application API that derives `customerId` from auth.
- Portal material upload/download with ownership checks.
- Customer application progress and final plan confirm/reject.
- E-sign provider abstraction, signing task, callback, evidence archive, and contract download.
- WeChat Pay payment order, prepay, notify verification, idempotency, auto write-off, and deposit ledger integration.
- Customer order, bill, deposit, and entitlement APIs/pages.
- Unified `ServiceCase` base for accident report and rescue request.
- WeChat service account notification and notification log/outbox.
- Security hardening: ownership enforcement, redaction, rate limit, CAPTCHA/risk control where needed.

### P1

- SMS notification provider and templates beyond login verification.
- Notification retry dashboard and operations tooling.
- Rich material type configuration by application stage/case type.
- Refund automation through the payment channel.
- Customer cancellation and re-submit refinements if not completed in 10B/10C P0.
- More detailed after-sales service SLA and dispatch workflow.

### P2

- Native WeChat mini-program.
- Enterprise customer portal.
- Customer free composition of product packages.
- Multi-payment-channel support beyond WeChat Pay.
- Advanced membership/marketing/coupon features.
- Full automated legal/archive integration beyond the selected e-sign provider scope.

## 9. Stage 10A-10H Implementation Split

### Stage 10.0: Customer Portal Takeover Audit

- Goal: audit current code/docs and produce this route map.
- Dependencies: production cutover baseline, current main branch.
- Backend scope: read-only inspection.
- Frontend scope: read-only inspection.
- Not doing: business development, schema change, migration, seed, production config, portal implementation.
- Acceptance: audit document committed; validation commands pass; Stage 10A can start with clear boundaries.

### Stage 10A: Customer Account and Portal Foundation

- Goal: establish customer portal shell, customer auth, and API security boundary.
- Dependencies: Stage 10.0.
- Backend scope: `CustomerAccount`, customer token/session, SMS verification-code auth, WeChat OAuth binding abstraction, `CustomerAuthGuard`, `/api/portal/me`, ownership utilities, rate limit hooks.
- Frontend scope: H5 portal route group, login page, session bootstrap, protected customer layout, WeChat service account entry landing.
- Not doing: catalog submission, payment, e-sign, service cases, native mini-program.
- Acceptance: customer can login, bind/identify account path is modeled, portal auth token cannot access admin APIs, admin token cannot satisfy customer ownership APIs unless explicitly supported by a safe operator path.

### Stage 10B: Product Browsing and Self-service Application

- Goal: allow guests to browse published products and logged-in customers to submit "提交审核".
- Dependencies: Stage 10A, active `SubscriptionPlan`, available vehicles.
- Backend scope: public/portal catalog APIs, publish/visibility fields if needed, vehicle image/gallery support if needed, redacted DTOs, `/api/portal/self-service-applications`, portal material upload.
- Frontend scope: product/vehicle list, detail page, plan selection, review notice, "提交审核" application form, material upload entry.
- Not doing: final plan confirmation, formal order generation from portal, payment, e-sign.
- Acceptance: guest browsing works; submission requires login; submission creates `SELF_SERVICE Application`; no formal order is created; customer can only select active preset plans; sensitive fields are not exposed.

### Stage 10C: Application Progress and Final Plan Confirmation

- Goal: let customers track application progress and confirm or reject final terms.
- Dependencies: Stage 10B, back-office review workflow.
- Backend scope: `/api/portal/applications`, `/api/portal/applications/:id`, final plan view DTO, customer confirm/reject endpoints, status transitions, customer cancellation where required.
- Frontend scope: application list/detail, progress timeline, material review status, final plan confirmation page, rejection/cancel affordance.
- Not doing: e-sign provider, payment provider.
- Acceptance: if final vehicle/deposit/period/monthly rent changes, customer must confirm again; rejection does not create order; confirmation enables the back-office order/contract path according to workflow.

### Stage 10D: Electronic Signature

- Goal: add provider-neutral e-sign capability for customer contract signing.
- Dependencies: Stage 10C and order/contract generation.
- Backend scope: e-sign provider interface, sign task model, signer info, signing URL, callback endpoint, status reconciliation, evidence file archive, customer contract download.
- Frontend scope: contract list/detail, signing entry, signing status, signed/archived contract download.
- Not doing: choosing a final vendor if procurement is still pending; payment implementation.
- Acceptance: a mock/provider abstraction can drive signing state in tests; callbacks are idempotent; customer only accesses own contracts; manual back-office sign endpoint is not used as the customer signing path.

### Stage 10E: Online Payment

- Goal: support WeChat Pay for deposit, first monthly rent, and monthly rent bills.
- Dependencies: Stage 10D for post-sign payments where applicable; billing/deposit records.
- Backend scope: `PaymentOrder`, WeChat Pay provider, prepay creation, notify signature verification, idempotency, payment status transitions, auto write-off, deposit ledger integration, refund boundary.
- Frontend scope: customer payment page, payable bill list, WeChat Pay invocation/QR/H5 handling, payment result page.
- Not doing: Alipay, bank card acquiring, full refund automation if deferred.
- Acceptance: successful notify can safely reconcile once; duplicate notify is idempotent; bills and deposit ledgers are updated; customer cannot pay another customer's bill.

### Stage 10F: Customer Bill / Deposit / Entitlement Center

- Goal: expose customer-facing financial and entitlement views.
- Dependencies: Stage 10A; Stage 10E for online payment state.
- Backend scope: `/api/portal/orders`, `/api/portal/bills`, `/api/portal/deposit`, `/api/portal/entitlements`, ownership filters, customer-safe summaries.
- Frontend scope: "我的订单", "我的账单", "押金", "权益" pages, payment entry from payable bills.
- Not doing: internal reports, collection workflow, revenue-rights finance views.
- Acceptance: every list/detail is filtered by current customer; internal aggregate report fields are not exposed; entitlements are grouped by customer order.

### Stage 10G: Accident Report and Rescue Request

- Goal: add unified customer service case foundation for accident and rescue.
- Dependencies: Stage 10A, portal upload ownership; preferably Stage 10F order lookup.
- Backend scope: `ServiceCase` base model, case type/status/priority, customer/order/vehicle relations, attachments, accident fields, rescue fields, operator handling APIs, audit/events.
- Frontend scope: report accident form, request rescue form, case list/detail, attachment upload, status timeline.
- Not doing: insurance claim settlement automation, repair shop dispatch integration, roadside provider integration unless selected.
- Acceptance: customer can create and track own accident/rescue cases; back office can triage; attachments remain private and ownership-checked.

### Stage 10H: WeChat Service Account and Notification Center

- Goal: connect service account entry and lifecycle notifications.
- Dependencies: Stage 10A account binding; event points from 10B-10G.
- Backend scope: WeChat OAuth callback, service account user binding, menu config support, notification template registry, notification outbox/log, WeChat template-message sender, retry/failure record.
- Frontend scope: OAuth landing page, service account menu target pages, notification preferences/basic message center if needed.
- Not doing: native mini-program, SMS notification P1, broad marketing automation.
- Acceptance: application/payment/contract/service-case lifecycle events can enqueue WeChat notifications; delivery attempts are logged; failures are observable and retryable.

## 10. Next Codex Development Content

The next implementation stage should be Stage 10A. Recommended first development slice:

- Add customer auth domain model and customer-account relation without changing back-office `User` semantics.
- Add SMS verification-code login for customer authentication.
- Add WeChat OAuth provider abstraction and account binding fields.
- Add `CustomerAuthGuard` and ownership helper utilities.
- Add `/api/portal/me` and a minimal customer portal session contract.
- Add H5 portal route group under the web app, including login and protected shell.
- Add tests proving back-office auth and customer auth are isolated.
- Add security tests for ownership enforcement.

Stage 10A should not implement product browsing, application submission, payment, e-sign, or service cases beyond stubs needed for auth/session.

## 11. Risks and Security Boundaries

### APIs That Must Not Be Directly Exposed to Customers

- Back-office customer management: `/api/customers*`.
- Back-office application management/review: `/api/applications*`.
- Current `POST /api/self-service-applications`.
- Product/package management APIs.
- Vehicle management and available vehicle APIs returning internal DTOs.
- Quote/order/contract manual operation APIs.
- Finance payment registration/write-off APIs.
- Report APIs and report detail/export APIs.
- Collection case APIs.
- System, role, permission, audit, seed, deployment, and admin-only endpoints.

### Fields Requiring Redaction

- Full VIN.
- Plate number unless business decides to reveal only after contract/payment.
- Purchase price and cost fields.
- Internal sale price history and valuation review fields.
- Internal customer risk/review comments.
- Deposit rule internals beyond customer-facing explanation.
- Internal user/operator IDs.
- Audit logs and back-office action notes.
- Payment proof URLs and storage object keys.
- OSS bucket/key/public URL internals.

### Portal API Boundary

Use `/api/portal/*` for customer APIs. Avoid overloading `/api/customer/*`, because `customer` already represents the back-office customer module in the current codebase.

Required rules:

- Use a separate `CustomerAuthGuard`.
- Derive `customerId` from the customer token/session, never from request body/query for ownership.
- Enforce `customerId` on every application, order, bill, deposit, entitlement, contract, material, and service-case query.
- File preview/download must check both file ownership and parent business object ownership.
- Public catalog APIs must use allowlisted DTOs only.
- Rate limit login, verification code, application submission, upload, payment prepay, and notification callbacks.
- Add CAPTCHA/risk checks where verification-code abuse is likely.
- Use independent customer access token/cookie settings from admin if domains/subdomains require separation.

## 12. Explicitly Deferred Items

- Native WeChat mini-program.
- Enterprise customer portal.
- Customer free composition of package components.
- Alipay or additional online payment channels.
- SMS notifications beyond login verification.
- Full refund automation if WeChat Pay refund is not needed for the first release.
- Repair shop, insurer, roadside assistance vendor integrations.
- Marketing automation and promotional coupon center.
- Changing production configuration during Stage 10.0.
- Modifying default seed during Stage 10.0.
- Prisma schema changes during Stage 10.0.

## 13. Audit Result

Stage 10.0 confirms that the existing system has a strong back-office operational core, but it does not yet have a production customer portal. The correct next step is Stage 10A: customer account and portal foundation.

The customer-side architecture should be built as a new portal boundary over reusable domain services, not by directly exposing existing admin APIs.

## 14. Stage 10A Status

Stage 10A has implemented the customer account and portal foundation on `feature/stage10-customer-account-portal`.

The implementation scope is intentionally limited to:

- Customer account and verification-code models.
- Customer JWT and `customer_access_token` cookie.
- `CustomerAuthGuard` and `currentCustomer` request boundary.
- `/api/portal/auth/*` and `/api/portal/me`.
- H5 routes `/portal/login`, `/portal`, and `/portal/me`.

Product browsing, self-service application submission, payment, e-sign, bills/entitlements, accident/rescue, real SMS, and real WeChat OAuth remain deferred to later Stage 10B-10H work.

## 15. Stage 10B Status

Stage 10B has implemented the customer-facing catalog and self-service application minimum loop on `feature/stage10-portal-catalog-application`.

Implemented:

- Public portal catalog APIs for customer-safe available vehicles and active subscription plans.
- Redacted catalog DTOs that do not expose purchase price, full VIN, full plate, financing, capital, residual, or sale-price review internals.
- Protected `POST /api/portal/self-service-applications`, deriving `customerId` from `CustomerAuthGuard`.
- Reuse of existing `SELF_SERVICE Application` creation logic, including `PENDING_CONFIRM` deposit, `REVIEW_RESERVED` vehicle state, and no formal order creation.
- Protected customer application list/detail APIs filtered by `currentCustomer.customerId`.
- Protected customer material upload/list/preview APIs using `StorageService` and API streaming instead of public OSS URLs.
- Protected customer cancellation for mutable pending self-service applications.
- H5 routes `/portal/catalog`, `/portal/catalog/[id]`, `/portal/applications`, and `/portal/applications/[id]`.
- `/portal/login` redirect support and `/portal` links to catalog/applications.
- Stage 10B documentation: `docs/stage-10b-portal-catalog-application.md`.

Remaining after Stage 10B:

- Product image/gallery publishing and customer publish status controls.
- Customer final plan confirmation or rejection.
- Electronic signature.
- Online payment.
- Customer bills, deposit, and entitlement center.
- Accident report and rescue service cases.
- WeChat OAuth/service account notification and real SMS provider.

Next recommended stage: Stage 10C, focused on application progress refinement and customer final plan confirmation before order/contract/payment.

## 16. Stage 10C Status

Stage 10C has implemented customer application progress and final plan second confirmation on `feature/stage10-portal-application-progress-final-plan`.

Implemented:

- Protected `GET /api/portal/applications/:id/progress`.
- Protected `GET /api/portal/applications/:id/final-plan`.
- Protected `POST /api/portal/applications/:id/final-plan/confirm`.
- Protected `POST /api/portal/applications/:id/final-plan/reject`.
- Customer-readable progress timeline and `nextAction`.
- Material supplement hints.
- Customer-safe final plan DTO that redacts full VIN, full plate, purchase price, sale price, and internal cost fields.
- Customer confirmation writes `planConfirmStatus = CONFIRMED` and `finalPlanConfirmedAt`.
- Customer rejection writes `planConfirmStatus = REJECTED` and `rejectedReason`.
- Back-office final plan generation now leaves `planConfirmStatus = PENDING` until customer confirmation.
- H5 `/portal/applications/[id]` final plan card and confirm/reject actions.
- Stage 10C documentation: `docs/stage-10c-portal-application-progress-final-plan.md`.

Strategy:

- Stage 10C uses Strategy B. Customer confirmation does not automatically create quote/order.
- Existing back-office `createOrderFromApplication` remains the formal order creation action after customer confirmation.

Remaining after Stage 10C:

- Electronic signature provider and customer signing link.
- Online payment.
- Customer bills, deposit, and entitlements.
- Accident report and rescue service cases.
- WeChat OAuth/service account notification and real SMS provider.

Next recommended stage: Stage 10D, focused on electronic signature after customer final plan confirmation.

## 17. Stage 10D-A Status

Stage 10D-A has implemented the electronic signature foundation on `feature/stage10-esign-foundation`.

Implemented:

- `ContractESignTask`, `ContractESignSigner`, and `ContractESignCallbackLog`.
- `ESignProvider` abstraction and `MockESignProvider`.
- Back-office APIs to start/query e-sign tasks.
- Public callback endpoint with callback log and idempotent completion handling.
- Protected Portal contract list/detail/signing-start APIs.
- Protected Portal mock signing completion API.
- H5 routes `/portal/contracts`, `/portal/contracts/[id]`, and `/portal/contracts/[id]/sign`.
- Back-office contract detail e-sign task section.
- Stage 10D-A documentation: `docs/stage-10d-esign-foundation.md`.

Strategy:

- Stage 10D-A does not connect a real e-sign provider.
- Starting e-sign can move a generated contract to `SIGNING`.
- Mock signing completion moves the contract to `SIGNED` and the order to `PENDING_PAYMENT`, matching the existing manual signing outcome.

Remaining after Stage 10D-A:

- Real provider adapter and signature verification rules.
- Contract PDF/evidence archive through provider callback.
- Online payment.
- Customer bills, deposit, and entitlements.
- Accident report and rescue service cases.
- WeChat OAuth/service account notification and real SMS provider.

Next recommended stage: Stage 10D-B if an e-sign provider is selected, otherwise Stage 10E-A for payment foundation.

## 18. Stage 10E-A Status

Stage 10E-A has implemented the payment foundation on `feature/stage10-payment-foundation`.

Implemented:

- `PaymentOrder`, `PaymentOrderItem`, and `PaymentCallbackLog`.
- `PaymentProvider` abstraction and `MockPaymentProvider`.
- Protected Portal payable-bill API.
- Protected Portal payment order create/detail/pay/mock-pay APIs.
- Public payment callback endpoint with callback log and idempotent paid handling.
- Mock payment completion that creates `PaymentRecord` through existing `FinanceService.createPayment`.
- Automatic write-off through existing `FinanceService.writeOffPayment`.
- Existing finance service updates `ReceivableBill` and creates `DepositLedger.COLLECT` for fully paid deposit bills.
- H5 routes `/portal/payment-orders/[id]` and `/portal/payment-orders/[id]/mock-pay`.
- Portal contract detail payment entry after signed contract and `PENDING_PAYMENT` order.
- Stage 10E-A documentation: `docs/stage-10e-payment-foundation.md`.

Strategy:

- Stage 10E-A does not connect real WeChat Pay.
- Mock payment is only available when `PAYMENT_PROVIDER=mock` and `PAYMENT_MOCK_ENABLED=true`.
- Production env examples keep Mock payment disabled by default.
- Payment completion does not directly advance the order state from `PENDING_PAYMENT`; existing delivery preparation remains the safe order-state transition point.

Remaining after Stage 10E-A:

- Real WeChat Pay provider, merchant configuration, API v3 signing, certificate handling, JSAPI/H5 prepay, and callback signature verification.
- Refunds, invoices, automatic debit, and reconciliation.
- Customer bill/deposit/entitlement center.
- Accident report and rescue service cases.
- WeChat OAuth/service account notification and real SMS provider.

Next recommended stage: Stage 10E-B for real WeChat Pay provider if merchant material is ready, otherwise Stage 10F for customer bill/deposit/entitlement center.

## 19. Stage 10E-B Status

Stage 10E-B implements the WeChat Pay JSAPI provider on `feature/stage10-wechat-jsapi-payment`.

Implemented:

- `WeChatPayProvider` for JSAPI prepay creation.
- Merchant API v3 request signing through configured private key path and serial number.
- JSAPI frontend payment parameter generation.
- Minimal Portal WeChat openid binding after phone login.
- Protected Portal WeChat OAuth URL and binding APIs plus public OAuth callback.
- WeChat Pay callback raw body preservation.
- Callback signature verification using configured WeChat Pay public key or platform certificate.
- Callback `resource` decryption with API v3 key.
- SUCCESS callback idempotency through `PaymentCallbackLog` and existing `PaymentOrder` completion.
- Portal payment page support for `WeixinJSBridge`.
- Stage 10E-B documentation: `docs/stage-10e-wechat-jsapi-payment.md`.

Strategy:

- Stage 10E-B only supports in-WeChat JSAPI payment.
- WeChat H5 payment outside the WeChat client is deferred to Stage 10E-C.
- No real WeChat merchant secret or certificate is committed.
- No production deployment or real charge is executed in this stage.

Remaining after Stage 10E-B:

- Staging small-amount real WeChat Pay verification.
- WeChat H5 fallback outside the WeChat client.
- Refunds, invoices, reconciliation, and automatic debit.
- Customer bill/deposit/entitlement center.
- Accident report and rescue service cases.

Next recommended stage: Stage 10E-B-Staging for a controlled small-amount real WeChat Pay verification.

Post-merge staging validation update:

- Real WeChat JSAPI small-amount validation has passed.
- A `0.01 CNY` payment was completed in the WeChat client.
- WeChat callback signature verification and `resource` decryption succeeded.
- `PaymentOrder` moved to `PAID`.
- `PaymentRecord` and `PaymentWriteOff` were created through the existing finance path.
- `ReceivableBill` was updated to `PAID`.
- Repeated SUCCESS callbacks were handled idempotently.

Stage 10E-B-CertRotation update:

- WeChat Pay platform certificate gray release should be treated as platform-certificate rotation, not merchant API certificate rotation.
- The system now supports `WECHAT_PAY_PLATFORM_CERTS` with multiple `serial:path` entries.
- Callback verification selects the platform certificate by `Wechatpay-Serial`.
- Unknown serials are recorded as `WECHATPAY_SERIAL_NOT_CONFIGURED` and do not mark `PaymentOrder` as paid.
- Legacy single public key / platform certificate path configuration remains supported when no multi-certificate mapping is configured.
- Runbook: `docs/wechat-pay-certificate-rotation.md`.

## 20. Stage 10F Status

Stage 10F implements the customer order, bill, deposit, and entitlement center on `feature/stage10-portal-billing-entitlements`.

Implemented:

- Protected Portal order list and order detail APIs.
- Protected Portal bill list and bill detail APIs.
- Protected Portal payment order list API.
- Protected Portal deposit overview and deposit transaction APIs.
- Protected Portal entitlement grant and usage APIs.
- H5 routes `/portal/orders`, `/portal/orders/[id]`, `/portal/bills`, `/portal/bills/[id]`, `/portal/payment-orders`, `/portal/deposit`, and `/portal/entitlements`.
- Portal home links for orders, bills, payment records, deposit, and entitlements.
- Payment entry reuse from bills and order detail through existing Stage 10E `POST /api/portal/payment-orders`.
- Stage 10F documentation: `docs/stage-10f-portal-billing-entitlements.md`.

Strategy:

- Stage 10F is read-only for finance, deposit, and entitlements.
- It does not add a payment provider or change WeChat Pay.
- It does not change bill generation, finance write-off, deposit ledger, or entitlement consume logic.
- Every endpoint uses `CustomerAuthGuard` and filters by `currentCustomer.customerId`.
- Portal responses redact vehicle purchase/current sale price, financing/capital structure, residual/cost data, full VIN, full plate number, internal review comments, and back-office operator-sensitive fields.

Remaining after Stage 10F:

- Accident report, rescue request, and shared `ServiceCase` foundation.
- WeChat service account notification center.
- Real SMS provider.
- WeChat H5 fallback outside the WeChat client.
- Refunds, invoices, reconciliation, and automatic debit.

Next recommended stage: Stage 10G for accident report, rescue request, and service case foundation.

## 21. Stage 10G-A Status

Stage 10G-A implements the shared ServiceCase foundation on `feature/stage10-service-case-portal`.

Implemented:

- New `ServiceCase`, `ServiceCaseAttachment`, and `ServiceCaseAction` models.
- Customer Portal accident report and rescue request creation.
- Customer-owned service-case list, detail, progress timeline, cancellation, attachment upload, and attachment preview.
- Back-office service-case list/detail plus accept, status update, note, and close operations.
- RBAC permissions `service_case:view` and `service_case:manage`.
- Back-office menu entry `订单中心 -> 服务工单`.
- H5 routes `/portal/service-cases`, `/portal/service-cases/new`, and `/portal/service-cases/[id]`.
- Back-office route `/service-cases`.
- Stage 10G documentation: `docs/stage-10g-service-case-portal.md`.

Strategy:

- ServiceCase is independent from `VehicleReturnDamage` and `CollectionCase`.
- Attachments reuse private `StorageService` and stream previews through ownership-checked APIs.
- Creating or handling a ServiceCase does not change order/vehicle status and does not generate bills.
- Insurance, rescue providers, dispatch, fees, WeChat notifications, and SMS notifications are deferred.

Remaining after Stage 10G-A:

- WeChat service account menu and notification center.
- Accident/rescue dispatch and supplier integrations.
- Service-case cost attribution, settlement, and customer evaluation.

Next recommended stage: Stage 10H for WeChat service account and notification center.

## 22. Stage 10H-A Status

Stage 10H-A implements the notification center foundation on `feature/stage10-notification-wechat-foundation`.

Implemented:

- New `NotificationTemplate`, `NotificationRecord`, and `NotificationEvent` models.
- Notification provider abstraction.
- Mock notification provider for dev, staging, and tests.
- WeChat Official Account provider foundation with access-token cache and template-message send method.
- Default no-real-send posture through `NOTIFICATION_PROVIDER=mock` and `NOTIFICATION_WECHAT_ENABLED=false`.
- Business event hooks for application submitted, final plan ready, contract pending, payment pending, service case submitted, and service case updates.
- Customer Portal notification APIs and `/portal/notifications`.
- Back-office notification center APIs and `/notifications`.
- RBAC permissions `notification:view` and `notification:manage`.
- WeChat service account menu dry-run script and setup guide.
- Stage 10H documentation: `docs/stage-10h-notification-wechat-foundation.md`.

Strategy:

- Notifications are best-effort and must not roll back the primary business workflow.
- Real WeChat template messages are deferred to Stage 10H-B.
- SMS, email, mini-program subscribe messages, marketing messages, and complex orchestration remain out of scope.

Next recommended stage: Stage 10H-B for real WeChat Official Account template-message and menu validation.

## 23. Stage 10H-B Status

Stage 10H-B adds the controlled real WeChat Official Account validation tooling on `feature/stage10-wechat-official-account-validation`.

Implemented:

- `scripts/wechat-official-account-smoke.mjs` for access-token smoke and single-openid template-message smoke.
- `scripts/wechat-menu.mjs` for menu dry-run and explicit-env guarded apply.
- Package commands `wechat:oa:smoke`, `wechat:menu:dry-run`, and `wechat:menu:apply`.
- Release syntax checks for the new WeChat Official Account scripts.
- Provider handling for numeric WeChat `msgid` values so `NotificationRecord.providerMessageId` is populated during real sends.
- Stage 10H-B validation report/runbook: `docs/stage-10h-wechat-official-account-validation.md`.

Safety posture:

- No AppSecret, access_token, full openid, or real template ID values are committed.
- Smoke sends are limited to one explicit test openid.
- Batch and wildcard sends are blocked.
- Menu apply requires `WECHAT_MENU_APPLY=1`.
- WeChat Pay certificate rotation, callback verification, payment posting, write-off, and receivable bill logic remain untouched.

Current validation state:

- Code-level checks and dry-run tooling are ready.
- Stage 10H-B real WeChat Official Account template-message validation is Pending.
- Blocking reason: WeChat Official Account normal template-message capability is still under platform review.
- Real WeChat access-token fetch, template send, menu apply, and WeChat-client click-through validation require operator-provided real environment values after the review passes, and are tracked in the Stage 10H-B report.

## 24. Stage 10I Status

Stage 10I hardens the customer Portal release path while the WeChat template-message review is pending.

Implemented:

- Portal route smoke script: `scripts/portal-route-smoke.mjs`.
- Portal API smoke script: `scripts/portal-api-smoke.mjs`.
- Package commands `portal:route-smoke` and `portal:api-smoke`.
- Release-check syntax coverage for the new Portal smoke scripts.
- Customer Portal privacy policy page at `/portal/privacy`.
- Customer Portal terms page at `/portal/terms`.
- Login agreement checkbox requiring customers to accept the terms and privacy policy before login.
- Portal security and redaction audit: `docs/portal-security-audit.md`.
- Customer Portal release checklist: `docs/customer-portal-release-checklist.md`.
- Customer Portal manual acceptance guide: `docs/customer-portal-manual-acceptance.md`.

Strategy:

- Stage 10I does not depend on real WeChat template IDs or real template sends.
- Stage 10I does not send WeChat template messages and does not apply WeChat menus.
- Stage 10I does not modify WeChat Pay provider logic, certificate rotation, payment posting, write-off, receivable bill logic, Prisma schema, or migrations.
- Real Stage 10H-B validation resumes as Stage 10H-B-R2 after WeChat template-message capability is approved.
