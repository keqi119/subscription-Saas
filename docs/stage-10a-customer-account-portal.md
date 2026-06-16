# Stage 10A Customer Account and Portal Foundation

> Date: 2026-06-16  
> Branch: `feature/stage10-customer-account-portal`  
> Scope: customer identity foundation, portal API boundary, and H5 shell.

## 1. Goal

Stage 10A establishes the minimum customer-side foundation for later Stage 10B-10H work:

- Who the customer is.
- How the customer logs in.
- How customer tokens are isolated from back-office admin tokens.
- How `/api/portal/*` APIs identify the current customer.
- Where the H5 customer portal starts.

This stage does not implement product browsing, self-service application submission, payment, e-sign, bills, entitlements, accident report, rescue, or real WeChat/SMS providers.

## 2. Customer Account Model

New model:

- `CustomerAccount`

Core fields:

- `customerId`
- `phone`
- `phoneVerifiedAt`
- `wechatOpenId`
- `wechatUnionId`
- `accountStatus`
- `lastLoginAt`
- `lastLoginIp`
- `lastUserAgent`

New verification model:

- `CustomerVerificationCode`

Core fields:

- `phone`
- `purpose`
- `codeHash`
- `expiresAt`
- `consumedAt`
- `attemptCount`
- `requestIp`
- `userAgent`

New enums:

- `CustomerAccountStatus`: `ACTIVE`, `DISABLED`
- `CustomerVerificationCodePurpose`: `LOGIN`, `BIND_PHONE`

`Customer` remains the business customer profile. `CustomerAccount` is the login account and links to `Customer`.

## 3. Token Isolation

Customer portal token:

- Cookie: `customer_access_token`
- JWT payload includes `tokenType = customer`
- Subject is `CustomerAccount.id`
- Payload carries `customerId` and `phone`

Back-office admin token:

- Cookie remains `access_token`
- Subject remains `User.id`
- Roles, permissions, and menus remain admin-only concepts.

`CustomerAuthGuard` does not read the admin cookie and rejects admin-shaped JWTs because they do not carry `tokenType = customer`.

## 4. SMS Code Mock Provider

Stage 10A uses a mock/console verification-code provider only.

Rules:

- Six-digit numeric code.
- Only `codeHash` is stored.
- Default TTL: 300 seconds.
- Default resend interval: 60 seconds.
- Default max attempts: 5.
- Wrong code increments `attemptCount`.
- Consumed code cannot be reused.
- Production hides `debugCode` unless `PORTAL_AUTH_DEBUG_CODE=true`.
- Development/staging may return `debugCode` for manual testing.

Real SMS provider integration is deferred.

## 5. Portal APIs

New endpoints:

- `POST /api/portal/auth/request-code`
- `POST /api/portal/auth/login`
- `POST /api/portal/auth/logout`
- `GET /api/portal/auth/me`
- `GET /api/portal/me`

`/api/portal/auth/me` and `/api/portal/me` both require `CustomerAuthGuard`.

First login behavior:

- If `CustomerAccount.phone` exists, login updates last-login fields.
- If no account exists, the service finds an existing `Customer.mobile`.
- If no customer exists, the service creates a lead `Customer`.
- Then it creates `CustomerAccount`.

This never creates a back-office `User`.

## 6. CustomerAuthGuard

`CustomerAuthGuard`:

- Reads `customer_access_token`.
- Verifies JWT signature.
- Requires `tokenType = customer`.
- Loads `CustomerAccount`.
- Requires `accountStatus = ACTIVE`.
- Requires `deletedAt = null`.
- Attaches `currentCustomer` to the request.

Future `/api/portal/*` APIs must derive `customerId` from `currentCustomer`, not from request body or query parameters.

## 7. H5 Routes

New web routes:

- `/portal/login`
- `/portal`
- `/portal/me`

Current behavior:

- `/portal/login` supports phone/code login.
- A disabled "微信登录，暂未开通" entry reserves the future OAuth path.
- `/portal` shows current phone/account status and placeholder entries.
- `/portal/me` shows current portal identity data.

Placeholder entries:

- 我的申请
- 我的订单
- 我的账单
- 我的权益
- 事故报案
- 救援申请

They intentionally show "即将上线" and do not implement business lists.

## 8. Environment Variables

New example variables:

- `CUSTOMER_JWT_SECRET`
- `CUSTOMER_ACCESS_TOKEN_COOKIE`
- `CUSTOMER_ACCESS_TOKEN_EXPIRES_IN`
- `PORTAL_OTP_TTL_SECONDS`
- `PORTAL_OTP_RESEND_SECONDS`
- `PORTAL_OTP_MAX_ATTEMPTS`
- `PORTAL_AUTH_DEBUG_CODE`
- `PORTAL_CORS_ORIGIN`

Production/staging examples extend `CORS_ORIGIN` to include the customer app domain. Existing production env files are not modified.

## 9. Not Done In 10A

- Product browsing.
- `POST /api/portal/self-service-applications`.
- Real WeChat OAuth.
- Real SMS provider.
- Electronic signature.
- WeChat Pay.
- Customer bill/deposit/entitlement center.
- Accident report or rescue request.
- Back-office admin auth changes.
- Order, contract, finance, or entitlement business logic changes.

## 10. Dependency For Later Stages

Stage 10B-10H must build on this boundary:

- Stage 10B: catalog and self-service application use customer auth.
- Stage 10C: application progress/final plan confirmation use `currentCustomer.customerId`.
- Stage 10D: e-sign signing links and downloads require customer ownership checks.
- Stage 10E: payment orders require bill/order ownership checks.
- Stage 10F: order, bill, deposit, and entitlement center must filter by `customerId`.
- Stage 10G: service cases must be tied to current customer.
- Stage 10H: WeChat OAuth binds to `CustomerAccount`.
