# Customer Portal Release Candidate Report

## RC Identity

- RC name: Customer Portal RC 10J.
- RC date: 2026-06-20.
- Branch: `feature/stage10-customer-portal-rc-deployment-fix`.
- Baseline commit: `ff40bd1` (`main`, after Stage 10J merge).
- R1 fix commit: `cf35dc7` (`fix: make portal legal pages production build safe`).
- R2 fix commit: `a122c05` (`fix: disable invalid portal payment actions`).
- R3 fix commit: `1355c85` (`fix: repair service case preview and transitions`).
- R4 fix commit: `692586a` (`fix: map service case wechat template fields`).
- R5 fix commit: `aa9289a` (`fix: guard service case wechat status enum values`).
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
- Stage 10K-A code now adds Aliyun SMS login provider support, SMS send logs, production `debugCode` suppression, and invited-beta phone gating. It still requires staging real-SMS validation before production rollout.

## Deferred Capability Scope

- Real e-sign provider integration: Stage 10D-B.
- WeChat-outside browser H5 payment fallback: Stage 10E-C.
- Refunds, reconciliation, and invoices: later payment enhancements.
- Broad SMS notification provider: P1. Login verification SMS is handled separately by Stage 10K-A.
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

Additional Stage 10J-R2 checks:

- Production database backup completed before migration: `/opt/subscription-saas/backups/subscription_saas_prod_20260620140248.dump`.
- Backup SHA256: `8be1b6f71979ec0d44b8a1e38ec1ffa3aeabf639b6ba36f0a59728eea954c74b`.
- Production `prisma migrate deploy` applied existing migrations `20260618143000_service_cases` and `20260618170000_notification_center`.
- Production migration status after deploy: database schema up to date, 40 migrations.
- Production tables verified: `service_case`, `notification_record`, and `notification_event`.
- Production seed executed through the R2 API container.
- Production role/menu seed verified for `orders.service_cases`, `orders.notifications`, `service_case:*`, and `notification:*`.
- R2 production route smoke against `https://app.subauto.keybox.cloud`: passed.
- R2 production public API smoke against `https://api.subauto.keybox.cloud/api`: passed.
- R2 unauthenticated protected-API probes returned expected `401` instead of `404` or `500` for notifications, service cases, order detail, and payment order detail routes.

Additional Stage 10J-R3 checks:

- `pnpm --filter @subscription-saas/web lint`: passed.
- `pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false`: passed.
- `pnpm --filter @subscription-saas/web build`: passed.
- Web bundle API base check passed for `https://api.subauto.keybox.cloud/api`.
- Production Web-only refresh deployed `ghcr.io/keqi119/subscription-web:portal-rc-r3-20260620-1355c85`.
- Production Web image digest: `ghcr.io/keqi119/subscription-web@sha256:ceec6025e2845b8d39f6d5d7c38af9a7b5f5097ca02fb756480caff6af79bfe4`.
- Production API image remained unchanged at `ghcr.io/keqi119/subscription-api:portal-rc-r2-20260620-a122c05`.
- Production route smoke passed after R3 deployment.
- Production page probes returned 200 for `/service-cases` and `/portal/service-cases/38cb3388-1a51-4b6a-bd44-9982b05ccac1`.

Additional Stage 10J-R4 checks:

- `pnpm --filter @subscription-saas/api lint`: passed.
- `pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json`: passed.
- `pnpm --filter @subscription-saas/api test`: passed, 42 test files / 630 tests.
- Production API image was refreshed to `ghcr.io/keqi119/subscription-api:portal-rc-r4-20260620-692586a`.
- Production API image digest: `ghcr.io/keqi119/subscription-api@sha256:4ebb676b5b6170c83091a23062ccbbf798e6d8aff8029d30e4b8c614c959396c`.
- Production Web image remained unchanged at `ghcr.io/keqi119/subscription-web:portal-rc-r3-20260620-1355c85`.
- Production API health probe passed after R4 deployment.
- Production public probes passed for catalog vehicles and subscription plans.
- Production route probes returned 200 for `/portal/service-cases` and `/portal/notifications`.
- PR quality gate passed after the R4 commit.

Additional Stage 10J-R5 checks:

- `pnpm --filter @subscription-saas/api lint`: passed.
- `pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json`: passed.
- `pnpm --filter @subscription-saas/api test -- notification.spec.ts`: passed, 11 tests.
- `pnpm --filter @subscription-saas/api test`: passed, 42 test files / 631 tests.
- Production API image was refreshed to `ghcr.io/keqi119/subscription-api:portal-rc-r5-20260620-aa9289a`.
- Production API image digest: `ghcr.io/keqi119/subscription-api@sha256:04e2c99c80ec8328d3112b258e6d44d38827462896a1b15d6a9f3e4dce2f1311`.
- Production Web image remained unchanged at `ghcr.io/keqi119/subscription-web:portal-rc-r3-20260620-1355c85`.
- Production API health probe passed after R5 deployment.

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

Stage 10J-R2 production API/Web refresh:

- Previous production API image: `ghcr.io/keqi119/subscription-api:stage10-cert-rotation-b5ced12-fix3`.
- Previous production Web image: `ghcr.io/keqi119/subscription-web:portal-rc-20260620-cf35dc7`.
- New production API image: `ghcr.io/keqi119/subscription-api:portal-rc-r2-20260620-a122c05`.
- New API image digest: `ghcr.io/keqi119/subscription-api@sha256:7f44ab01e2dccd262afd8f5e99572adb6b77766b1065d4ee9e0e8014b7fec1b3`.
- New production Web image: `ghcr.io/keqi119/subscription-web:portal-rc-r2-20260620-a122c05`.
- New Web image digest: `ghcr.io/keqi119/subscription-web@sha256:ea0fe110d6ff8ba543ec45b627d01f612a8673b2204740b1b431c428aec41569`.
- Production containers after deployment: API healthy, Web healthy, Postgres healthy.
- Production route smoke result after R2 deployment: passed.
- `/portal/service-cases`: 200 route shell.
- `/portal/service-cases/new`: 200 route shell.
- `/portal/notifications`: 200 route shell.
- `/portal/orders/__smoke__`: 200 route shell.
- `/portal/payment-orders/__smoke__`: 200 route shell.

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

Stage 10J-R2 API route probes without a customer cookie:

- `GET /api/portal/notifications?pageSize=50`: 401 `Unauthorized`, route exists.
- `GET /api/portal/service-cases`: 401 `Unauthorized`, route exists.
- `GET /api/portal/orders/a2c96de8-f243-4c86-b022-8cac31bb9775`: 401 `Unauthorized`, route exists.
- `GET /api/portal/payment-orders/60342352-0678-4ba7-92e9-f596cb28caa5`: 401 `Unauthorized`, route exists.

This closes the production `Cannot GET /api/portal/notifications` and missing-table 500 blockers at the deployment layer. Authenticated browser retest is still required with a real customer session.

Stage 10J-R3 UI fixes:

- Portal service-case attachment preview now resolves protected preview URLs through `NEXT_PUBLIC_API_BASE_URL`, matching the existing application-material preview behavior.
- Back-office service-case status update now shows only API-allowed next statuses for the current state.
- For a newly submitted case such as `SC202606200645386M2Q`, the correct flow is `SUBMITTED -> ACCEPTED -> IN_PROGRESS -> RESOLVED`; the UI no longer offers direct `SUBMITTED -> RESOLVED`.
- No API status-machine changes were made.

Stage 10J-R4 notification fix:

- Production service-case WeChat notifications failed with `WECHAT_TEMPLATE_SEND_FAILED:47003` because the active WeChat template expects keys such as `character_string2`, `const3`, `thing1`, `time6`, and `const4`.
- The API now maps service-case notification payloads to those provider fields while preserving the existing internal payload keys.
- Historical failed records remain `FAILED` and are not automatically resent.
- Controlled retest is required by triggering a new valid service-case status transition after R4 deployment.

Stage 10J-R5 notification enum guard:

- Post-R4 retest proved that `处理中` succeeds, while `待客户补充` and `已解决` are still rejected by WeChat with `data.const4.value invalid`.
- R5 keeps the internal service-case status unchanged in the notification payload, but sends only audited WeChat `const4` values to the template API.
- Default WeChat `const4` allowlist is currently `处理中`.
- When WeChat approves additional enum values, configure `WECHAT_SERVICE_CASE_STATUS_CONST4_ALLOWLIST`, for example `处理中,已解决,待客户补充`, and retest before broad rollout.

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

Stage 10J-R2 added a Portal UI guard that disables the payment action when the payment order is no longer payable, for example `CANCELLED`, `CLOSED`, `EXPIRED`, `FAILED`, `PAID`, or when all linked bill items are not payable. This is a frontend action-state fix only; it does not alter WeChat Pay provider, callback, posting, write-off, or receivable-bill logic.

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

Stage 10J-R4 follow-up:

- Service-case progress notifications are now mapped to the active WeChat service-case template fields.
- Three pre-R4 service-case notification records failed with `WECHAT_TEMPLATE_SEND_FAILED:47003`; these records should remain failed for auditability.
- Post-R4 verification should use a new single-customer service-case status transition and confirm `NotificationRecord.notificationStatus = SENT`, `NotificationEvent.eventStatus = PROCESSED`, WeChat receipt, and Portal click-through.

Stage 10J-R5 follow-up:

- R4/R5 retest records show one successful WeChat service-case message for `处理中`.
- Two later service-case messages failed because WeChat had not yet accepted `待客户补充` and `已解决` for template field `const4`.
- R5 mitigates that provider enum restriction by falling back to the audited `处理中` enum value for WeChat only.
- Verify with a new single-customer service-case update after R5 deployment; old failed records should remain failed.

Stage 10J-R6 follow-up:

- R5 fallback avoided WeChat `47003`, but it could make a WeChat card display `处理中` while the Portal detail page already showed a terminal status such as `已关闭`.
- R6 supersedes the fallback behavior: when `const4` is not in `WECHAT_SERVICE_CASE_STATUS_CONST4_ALLOWLIST`, the WeChat channel is recorded as `SKIPPED` with `WECHAT_TEMPLATE_CONST4_NOT_APPROVED:<status>`.
- Portal in-app notifications and internal payloads continue to keep the real service-case status.
- This prevents sending misleading WeChat messages while WeChat template enum values are still under approval.

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
- Production customer login previously depended on a mock/debug code path. Stage 10K-A closes this in code with Aliyun SMS and beta gate support, but real SMS staging validation is still required before customer traffic.

Closed in Stage 10J-R1:

- Production H5 route 404 blocker for `/portal/terms`, `/portal/privacy`, and `/portal/notifications`.

Closed in Stage 10J-R2:

- Production API image was refreshed to include service case and notification routes.
- Production database was migrated to include `service_case`, `notification_record`, and `notification_event`.
- Production seed restored back-office service-case and notification-center menus and permissions.
- Unauthenticated protected-API probes now return expected `401` instead of `Cannot GET` or `500`.
- Invalid Portal payment action for cancelled/non-payable payment orders is disabled in the Web UI.

Closed in Stage 10J-R3:

- Portal service-case attachment preview no longer opens the Web-domain `/api/...` path.
- Back-office service-case status dropdown no longer offers invalid transitions such as direct `SUBMITTED -> RESOLVED`.

## Go / No-Go Recommendation

No-Go for unrestricted real-customer launch.

Allowed next step: Customer Portal RC manual retest with a real customer session. If the browser retest passes, proceed to internal RC validation or invited beta planning.

Go criteria for customer-facing rollout:

- Production route smoke passes all Portal routes.
- Production public API smoke passes.
- Production authenticated API smoke passes with a controlled customer cookie.
- Stage 10K-A-Staging real Aliyun SMS validation passes for one controlled phone, with production-like `debugCode=false` and beta whitelist enforcement.
- Legal approves terms/privacy or explicitly approves placeholder text for invited beta.
- Business owner confirms whether Mock ESignProvider is acceptable for the release scope.
- WeChat Official Account menu apply is either executed with explicit confirmation or deliberately deferred in release notes.

## Stage 10L-A Vehicle Listing Update

Stage 10L-A adds richer customer-side vehicle listing data and a back-office maintenance surface for listing profiles, media galleries, and optional display-plan configuration.

RC impact:

- Customer catalog and detail pages now have a richer one-car-one-condition presentation.
- Customer CTA copy remains application review oriented: `提交审核`.
- No direct order creation, payment change, contract change, bill change, entitlement change, service-case change, or notification-send change is included.
- Private listing media is streamed through API preview routes; Portal responses do not expose storage internals.
- This improvement does not close the remaining unrestricted-launch blockers listed above.
