# Customer Portal Release Candidate Report

## RC Identity

- RC name: Customer Portal RC 10J.
- RC date: 2026-06-20.
- Branch: `feature/stage10-customer-portal-rc-deployment-fix`.
- Baseline commit: `ff40bd1` (`main`, after Stage 10J merge).
- R1 fix commit: `cf35dc7` (`fix: make portal legal pages production build safe`).
- Target H5 domain: `https://app.subauto.keybox.cloud`.
- Target API domain: `https://api.subauto.keybox.cloud/api`.
- Back-office dependency: `https://admin.subauto.keybox.cloud`.

## Completed Capability Scope

The current Stage 10 customer Portal codebase covers:

- Customer login with `customer_access_token`.
- Public vehicle/catalog browsing.
- Self-service application submission.
- Customer material upload and preview.
- Application progress and final plan query.
- Final plan confirm/reject.
- Portal contracts with Mock ESignProvider signing flow.
- WeChat JSAPI payment provider.
- Real 0.01 CNY WeChat Pay validation with payment posting and write-off.
- WeChat Pay platform certificate rotation and multi-certificate callback verification.
- Portal orders.
- Portal bills and payment records.
- Portal deposit ledger.
- Portal entitlements.
- Accident report and rescue request service cases.
- Portal notification center.
- Back-office notification center.
- WeChat Official Account template-message provider foundation.
- Real WeChat Official Account `PAYMENT_PENDING` single-openid template send.
- WeChat `msgid` persistence in `NotificationRecord.providerMessageId`.
- WeChat client receipt and click-through to the Portal order page.

## Deferred Capability Scope

- Real e-sign provider integration: Stage 10D-B.
- WeChat-outside browser H5 payment fallback: Stage 10E-C.
- Refunds, reconciliation, and invoices: later payment enhancements.
- SMS notification provider: P1.
- WeChat Official Account menu apply: pending explicit manual confirmation.
- Legal-approved final terms and privacy policy: release prerequisite.
- Native mini-program: P2.
- Enterprise customer portal: P2.

## Validation Results

### Local Validation Results

Executed on branch `feature/stage10-customer-portal-release-candidate` during Stage 10J:

- `pnpm -r lint`: passed.
- `pnpm prisma:validate`: passed.
- `pnpm prisma:generate`: passed.
- `pnpm prisma:seed`: passed.
- `pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json`: passed.
- `pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false`: passed.
- `pnpm --filter @subscription-saas/api test`: passed, 42 test files / 630 tests.
- `pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma`: passed, 40 migrations, database schema up to date.
- `pnpm release:check`: passed.
- `node --check scripts/portal-route-smoke.mjs`: passed.
- `node --check scripts/portal-api-smoke.mjs`: passed.

No Prisma schema changes or migrations were added.

Additional Stage 10J-R1 checks:

- `pnpm -r lint`: passed.
- `pnpm prisma:validate`: passed.
- `pnpm prisma:generate`: passed.
- `pnpm prisma:seed`: passed.
- `pnpm --filter @subscription-saas/web build`: passed after the legal-page production build fix.
- `pnpm --filter @subscription-saas/web lint`: passed.
- `pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json`: passed.
- `pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false`: passed.
- `pnpm --filter @subscription-saas/api test`: passed, 42 test files / 630 tests.
- `pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma`: passed, 40 migrations, database schema up to date.
- `pnpm release:check`: passed.
- `pnpm portal:route-smoke` against `https://app.subauto.keybox.cloud`: passed.
- `pnpm portal:api-smoke` against `https://api.subauto.keybox.cloud/api`: passed for public endpoints; authenticated smoke skipped because no `PORTAL_CUSTOMER_COOKIE` was supplied.
- `pnpm wechat:menu:dry-run`: passed; no WeChat API call was made.

### Environment Smoke Results

#### Portal Route Smoke

Command:

```powershell
$env:PORTAL_BASE_URL="https://app.subauto.keybox.cloud"
pnpm portal:route-smoke
```

Initial Stage 10J result: failed for the production H5 domain.

Initial failing production routes:

- `/portal/terms`: 404.
- `/portal/privacy`: 404.
- `/portal/notifications`: 404.

Interpretation: the routes existed in the repository, but production was still running an older Web image that did not include Stage 10I legal pages and Stage 10H-A Portal notifications.

Stage 10J-R1 deployment fix:

- Previous production Web image: `ghcr.io/keqi119/subscription-web:stage10-cert-rotation-b5ced12-fix3`.
- New production Web image: `ghcr.io/keqi119/subscription-web:portal-rc-20260620-cf35dc7`.
- New Web image digest: `ghcr.io/keqi119/subscription-web@sha256:62a8ab9561494dbb0640c293789e260576cdba11e0dcd5191dba94388df128cc`.
- Production API image remained unchanged: `ghcr.io/keqi119/subscription-api:stage10-cert-rotation-b5ced12-fix3`.
- Bundle API base check passed: required `https://api.subauto.keybox.cloud/api` found; forbidden `staging-api.subauto.keybox.cloud` not found.
- Production deploy used `docker compose -p subauto-production ... up -d --no-deps web` to avoid API/Postgres changes.
- Web container status after deployment: `subauto-production-web-1` healthy.
- Operator note: an initial compose command without `-p subauto-production` created temporary sidecar containers under the default project name; they were removed immediately and the real production API/Postgres containers remained healthy.

Stage 10J-R1 route smoke retest result: passed.

Previously failing routes now pass:

- `/portal/terms`: 200.
- `/portal/privacy`: 200.
- `/portal/notifications`: 200.

All Portal route smoke checks passed, including public pages, protected route shells, and WeChat menu target URLs.

#### Portal API Smoke

Command:

```powershell
$env:PORTAL_API_BASE_URL="https://api.subauto.keybox.cloud/api"
pnpm portal:api-smoke
```

Result: passed for public endpoints.

- `GET /api/portal/catalog/vehicles`: 200.
- `GET /api/portal/catalog/subscription-plans`: 200.

Authenticated Portal API smoke was skipped because no `PORTAL_CUSTOMER_COOKIE` was supplied to the agent. No cookie was printed or committed.

#### WeChat Official Account Menu Dry-Run

Command:

```powershell
pnpm wechat:menu:dry-run
```

Result: passed. The dry-run printed the customer-facing menu JSON and did not call the WeChat API.

Menu targets:

- `https://app.subauto.keybox.cloud/portal/catalog`
- `https://app.subauto.keybox.cloud/portal/applications`
- `https://app.subauto.keybox.cloud/portal/orders`
- `https://app.subauto.keybox.cloud/portal/bills`
- `https://app.subauto.keybox.cloud/portal/entitlements`
- `https://app.subauto.keybox.cloud/portal/service-cases/new?type=ACCIDENT_REPORT`
- `https://app.subauto.keybox.cloud/portal/service-cases/new?type=RESCUE_REQUEST`

Menu apply status: not executed. Release apply requires explicit human confirmation and `WECHAT_MENU_APPLY=1`.

## Payment Validation

Stage 10E-B and Stage 10E-B-CertRotation are complete:

- Real 0.01 CNY WeChat JSAPI payment completed.
- WeChat callback signature verification passed.
- Callback resource decryption passed.
- `PaymentOrder` posting passed.
- `PaymentRecord`, `PaymentWriteOff`, and `ReceivableBill` write-off passed.
- Multi-platform-certificate callback verification passed.

No payment provider, certificate rotation, posting, write-off, or receivable-bill logic was modified in Stage 10J.

## WeChat Template-Message Validation

Stage 10H-B is complete:

- Real service-account `access_token` smoke passed.
- One `PAYMENT_PENDING` template message was sent to exactly one test openid.
- No mass send was performed.
- `NotificationRecord.notificationStatus = SENT`.
- `NotificationEvent.eventStatus = PROCESSED`.
- WeChat `msgid` was saved in `providerMessageId`.
- Provider response did not contain access_token.
- Test WeChat client receipt was confirmed.
- Clicking the message opened the Portal order page.

## Data Security And Ownership

Security posture is documented in `docs/portal-security-audit.md`.

RC status:

- `CustomerAuthGuard` protects Portal private APIs.
- Admin and customer cookies/tokens are separate.
- Ownership checks cover applications, contracts, payment orders, orders, bills, deposit, entitlements, service cases, and notifications.
- OSS previews stream through API ownership checks instead of public object URLs.
- Portal DTOs are designed to redact purchase price, cost, financing, residual internals, full VIN/plate where not intended, storage internals, and provider secrets.

Authenticated production API smoke still needs a controlled customer cookie before public rollout.

## Legal Text

The repository contains `/portal/terms` and `/portal/privacy`, and Stage 10J-R1 production route smoke confirms both pages now return 200. Both pages are still placeholder "pending legal review" versions.

Release requirement:

- For invited beta: legal must explicitly approve use of placeholder text.
- For real customer rollout: replace both pages with legal-approved text before opening traffic.

## Release Blockers

Current RC recommendation: No-Go for broad production customer rollout.

Blockers:

- Authenticated Portal API smoke was not executed because no controlled customer cookie was supplied.
- Legal-approved final terms/privacy text is not yet in place.
- Real e-sign provider is not integrated; Mock ESignProvider is still used.

Closed in Stage 10J-R1:

- Production H5 route 404 blocker for `/portal/terms`, `/portal/privacy`, and `/portal/notifications`.

## Go / No-Go Recommendation

No-Go for unrestricted real-customer launch.

Allowed next step: Customer Portal RC manual acceptance, internal RC validation, or invited beta planning after route smoke passed with the refreshed Web image.

Go criteria for customer-facing rollout:

- Production route smoke passes all Portal routes.
- Production public API smoke passes.
- Production authenticated API smoke passes with a controlled customer cookie.
- Legal approves terms/privacy or explicitly approves placeholder text for invited beta.
- Business owner confirms whether Mock ESignProvider is acceptable for the release scope.
- WeChat Official Account menu apply is either executed with explicit confirmation or deliberately deferred in release notes.
