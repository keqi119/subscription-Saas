# Customer Portal Production Rollout Plan

## Goal

Roll out the Stage 10 customer Portal as a controlled release candidate on:

- H5: `https://app.subauto.keybox.cloud`
- API: `https://api.subauto.keybox.cloud/api`
- Back office: `https://admin.subauto.keybox.cloud`

The rollout should first target internal validation or invited beta users. It should not become an unrestricted real-customer launch until the RC blockers in `docs/customer-portal-release-candidate-report.md` are cleared.

## Release Scope

Included:

- Customer login, with Stage 10K-A SMS provider and invited beta gate once real SMS staging validation passes.
- Public catalog browsing.
- Self-service application.
- Material upload and preview.
- Application progress and final plan confirmation.
- Portal contracts through Mock ESignProvider.
- WeChat JSAPI payment.
- Orders, bills, payment records, deposit, and entitlements.
- Accident report and rescue request.
- Portal and back-office notification center.
- WeChat Official Account template-message notifications.

Out of scope:

- Real e-sign provider.
- WeChat-outside browser H5 payment fallback.
- Refund automation.
- Reconciliation automation.
- Invoice workflow.
- Broad SMS notification provider. Login verification SMS is handled by Stage 10K-A and is not a notification-center batch/mass-send capability.
- Native mini-program.
- Enterprise customer portal.

## Domain And Dependency Checks

Before rollout:

- `app.subauto.keybox.cloud` must serve the latest Web image over HTTPS.
- `api.subauto.keybox.cloud/api/health` must be healthy.
- `admin.subauto.keybox.cloud` must remain available for operator workflow.
- CORS and cookies must support the H5/API domain combination.
- Production route smoke must pass for `/portal/terms`, `/portal/privacy`, and `/portal/notifications`.

Stage 10J-R1 status:

- Production Web image was refreshed to `ghcr.io/keqi119/subscription-web:portal-rc-20260620-cf35dc7`.
- Web image digest: `ghcr.io/keqi119/subscription-web@sha256:62a8ab9561494dbb0640c293789e260576cdba11e0dcd5191dba94388df128cc`.
- Bundle API base check passed for `https://api.subauto.keybox.cloud/api`.
- Production route smoke passed for `/portal/terms`, `/portal/privacy`, `/portal/notifications`, and all configured menu target pages.
- Production API image was not changed during the Web-only refresh.

Stage 10J-R2 status:

- Production database backup completed before API/Web refresh: `/opt/subscription-saas/backups/subscription_saas_prod_20260620140248.dump`.
- Existing production migrations `20260618143000_service_cases` and `20260618170000_notification_center` were applied with `prisma migrate deploy`.
- Production migration status is up to date at 40 migrations.
- Production API image was refreshed to `ghcr.io/keqi119/subscription-api:portal-rc-r2-20260620-a122c05`.
- Production API image digest: `ghcr.io/keqi119/subscription-api@sha256:7f44ab01e2dccd262afd8f5e99572adb6b77766b1065d4ee9e0e8014b7fec1b3`.
- Production Web image was refreshed to `ghcr.io/keqi119/subscription-web:portal-rc-r2-20260620-a122c05`.
- Production Web image digest: `ghcr.io/keqi119/subscription-web@sha256:ea0fe110d6ff8ba543ec45b627d01f612a8673b2204740b1b431c428aec41569`.
- Production seed was executed and service-case / notification menus and permissions were verified for back-office roles.
- Production route smoke passed after the API/Web refresh.
- Production public API smoke passed after the API/Web refresh.
- Protected Portal API probes without a customer cookie return expected `401` instead of `404` or `500`.

Stage 10J-R3 status:

- Production Web image was refreshed to `ghcr.io/keqi119/subscription-web:portal-rc-r3-20260620-1355c85`.
- Production Web image digest: `ghcr.io/keqi119/subscription-web@sha256:ceec6025e2845b8d39f6d5d7c38af9a7b5f5097ca02fb756480caff6af79bfe4`.
- Production API image remained unchanged at `ghcr.io/keqi119/subscription-api:portal-rc-r2-20260620-a122c05`.
- The refresh fixed Portal service-case attachment preview URL construction and back-office service-case status-transition options.
- Production route smoke passed after the Web-only refresh.

Stage 10J-R4 status:

- Production API image was refreshed to `ghcr.io/keqi119/subscription-api:portal-rc-r4-20260620-692586a`.
- Production API image digest: `ghcr.io/keqi119/subscription-api@sha256:4ebb676b5b6170c83091a23062ccbbf798e6d8aff8029d30e4b8c614c959396c`.
- Production Web image remained unchanged at `ghcr.io/keqi119/subscription-web:portal-rc-r3-20260620-1355c85`.
- The refresh maps service-case notification payloads to the active WeChat template fields to address `WECHAT_TEMPLATE_SEND_FAILED:47003`.
- Historical failed notification records are retained as `FAILED`; verify the fix with a new valid service-case status transition.

Stage 10J-R5 status:

- Production API image was refreshed to `ghcr.io/keqi119/subscription-api:portal-rc-r5-20260620-aa9289a`.
- Production API image digest: `ghcr.io/keqi119/subscription-api@sha256:04e2c99c80ec8328d3112b258e6d44d38827462896a1b15d6a9f3e4dce2f1311`.
- Production Web image remained unchanged at `ghcr.io/keqi119/subscription-web:portal-rc-r3-20260620-1355c85`.
- The refresh guards service-case WeChat template `const4` values with an allowlist because WeChat rejected unaudited enum values such as `待客户补充` and `已解决`.
- Default service-case WeChat `const4` value is currently `处理中`; expand `WECHAT_SERVICE_CASE_STATUS_CONST4_ALLOWLIST` only after WeChat enum approval.

Stage 10J-R6 status:

- Production API image was refreshed to `ghcr.io/keqi119/subscription-api:portal-rc-r6-20260620-4188aec`.
- Production API image digest: `ghcr.io/keqi119/subscription-api@sha256:bf10d831a24fa99abee7a8ba915bf18b0ae958b374e04c0a09a404c09c74e9fc`.
- Production Web image remained unchanged at `ghcr.io/keqi119/subscription-web:portal-rc-r3-20260620-1355c85`.
- R6 supersedes the R5 fallback behavior: unapproved service-case WeChat `const4` values are skipped instead of being replaced with `处理中`.
- This keeps WeChat cards from displaying a status that disagrees with the Portal detail page.

Stage 10K-A code status:

- The API now has an SMS provider abstraction with mock and Aliyun implementations for Portal login verification codes.
- `SmsSendLog` records login SMS send results, provider request/message ids, sanitized provider response, and failure reason.
- Production suppresses `debugCode` unconditionally.
- `PORTAL_BETA_MODE=true` restricts Portal request-code and login to `PORTAL_BETA_ALLOWED_PHONES`.
- This stage does not send real SMS and does not deploy to production. Proceed next to Stage 10K-A-Staging for one controlled real Aliyun SMS validation.

## WeChat Official Account Menu Strategy

Menu dry-run has passed and points only to customer Portal URLs.

Menu apply rules:

- Do not apply automatically.
- Apply only after human review of the menu JSON.
- Apply only with `WECHAT_MENU_APPLY=1`.
- Keep a screenshot/export of the old menu before replacement if the service account already has a live menu.
- Record the apply time, WeChat response, and client visibility after refresh.

Menu apply may be deferred for invited beta if users receive direct H5 links.

## WeChat Template-Message Strategy

Stage 10H-B validation has passed:

- Real access_token retrieval succeeded without printing token.
- One `PAYMENT_PENDING` message was sent to exactly one test openid.
- WeChat `msgid` was saved.
- WeChat client receipt and click-through to the Portal order page were confirmed.

Rollout rules:

- Keep template sends transactional only.
- Do not perform mass messaging.
- Do not send marketing pushes.
- Keep AppSecret, access_token, full openid, and full template IDs out of Git and logs.
- Confirm each production template ID mapping through environment variables, not hardcoded source.
- For service-case progress notifications, confirm the active WeChat template field names before release and retest after any template change.
- For service-case status enum values, keep `WECHAT_SERVICE_CASE_STATUS_CONST4_ALLOWLIST` aligned with the approved WeChat template enum list; unapproved values should be skipped, not remapped to another status.

## Payment Strategy

Stage 10E-B and certificate rotation have passed real validation.

Rollout rules:

- Use WeChat JSAPI inside the WeChat client for the first release.
- Keep WeChat-outside browser H5 payment deferred to Stage 10E-C.
- Do not change payment provider, callback verification, posting, write-off, or receivable-bill logic during rollout.
- Monitor `PaymentOrder`, `PaymentCallbackLog`, `PaymentRecord`, `PaymentWriteOff`, and `ReceivableBill` after each pilot payment.
- Keep platform-certificate mappings current and verify unknown serial handling remains no-pay/no-write-off.

## E-Sign Strategy

The current customer contract flow still uses Mock ESignProvider.

Release decision required:

- For invited beta or internal trial, business owner must explicitly accept Mock ESignProvider.
- For real customer launch, confirm whether a real e-sign provider is legally required before customer access.
- Stage 10D-B should integrate the real provider, callback verification, evidence archive, and provider-side signing status.

## OSS File Strategy

- Keep OSS buckets private.
- Do not expose public object URLs.
- Stream material and service-case attachments through ownership-checked API endpoints.
- Monitor upload size/type restrictions and storage errors during invited beta.

## Legal Text Strategy

Current `/portal/terms` and `/portal/privacy` pages are placeholder "pending legal review" versions.

Release rules:

- For internal RC: placeholders are acceptable only if operators know they are not final.
- For invited beta: legal must explicitly approve temporary text.
- For real customer launch: replace placeholders with formal legal-approved terms and privacy policy.
- Production now serves both pages after the Stage 10J-R1 Web image refresh; final legal-approved text is still required before unrestricted customer launch.

## Rollout Steps

1. Confirm latest `main` includes Stage 10A through Stage 10H-B and Stage 10J documentation.
2. Build immutable Web/API images from the release commit. For Web-only route fixes, build an immutable Web image and keep the API image unchanged.
3. Back up the production database before any migration or API refresh.
4. Deploy images to production using the documented image deployment path. For Web-only route fixes, use the production compose project and `--no-deps web`.
5. Verify database migrations are up to date with `prisma migrate status`.
6. Apply only existing migrations with `prisma migrate deploy` when production is behind the release commit.
7. Do not run `prisma migrate reset` or `prisma db push`.
8. Run the production seed when menus, permissions, or seed-managed templates changed.
9. Verify H5 domain, API health, and admin domain.
10. Run production route smoke:

   ```powershell
   $env:PORTAL_BASE_URL="https://app.subauto.keybox.cloud"
   pnpm portal:route-smoke
   ```

11. Run production public API smoke:

   ```powershell
   $env:PORTAL_API_BASE_URL="https://api.subauto.keybox.cloud/api"
   pnpm portal:api-smoke
   ```

12. Run authenticated API smoke with a controlled customer cookie; do not commit or print the cookie.
13. Before invited beta, configure `APP_ENV=production`, `PORTAL_SMS_PROVIDER=aliyun`, `PORTAL_SMS_ENABLED=true`, `PORTAL_SMS_DEBUG_CODE=false`, `PORTAL_BETA_MODE=true`, and a real allowlist outside Git.
14. Run Stage 10K-A-Staging with one controlled phone and confirm real SMS receipt, login success, non-whitelist rejection, and `SmsSendLog` provider request ids.
15. Run WeChat menu dry-run.
16. Decide whether to apply the WeChat service-account menu.
17. Execute a controlled customer journey: login, catalog, application, materials, final plan, contract, payment, bills, service case, notifications.
18. Confirm WeChat template notification receipt/click-through.
19. Record Go / No-Go.

## Rollback Steps

Rollback should avoid data-destructive actions.

1. Keep previous immutable Web/API image tags available.
2. If the H5 release fails, roll back the Web image first.
3. If the API release fails, roll back the API image only after confirming no migration incompatibility.
4. Do not revert payment callback, certificate rotation, posting, write-off, or receivable-bill data manually.
5. If WeChat menu apply was executed and must be reverted, re-apply the saved previous menu payload through the same explicit apply process.
6. Preserve logs and smoke output for the incident record.

## Post-Release Observation

Monitor:

- H5 route errors and 404s.
- API 5xx rate.
- Login success/failure rate.
- Portal ownership/security errors.
- OSS upload/preview failures.
- Payment prepay/callback success rate.
- WeChat Pay callback serial mismatches.
- Payment posting/write-off mismatches.
- WeChat Official Account template send failures.
- Service-case WeChat template field mismatches such as `47003`.
- WeChat service-case enum-value rejections for `const4`.
- Notification record/event failures.
- Service-case creation volume.
- Customer support issues around terms/privacy, signing, and payment.

## Go / No-Go

Current recommendation: No-Go for unrestricted production launch.

Proceed only with internal RC or invited beta after:

- Latest API/Web images are deployed and route/API smoke passes. Stage 10J-R2 has closed the production route/API deployment blockers found during RC acceptance.
- Stage 10J-R4 service-case notification retest passes after a new valid status transition.
- Stage 10J-R5 service-case notification retest confirms the enum guard prevents `47003`.
- Stage 10K-A-Staging confirms real Aliyun SMS login and beta whitelist behavior without debugCode or secret leakage.
- Legal explicitly accepts placeholder text or formal text is deployed.
- Authenticated API smoke passes.
- Business owner explicitly accepts Mock ESignProvider for the release scope.
- WeChat menu apply decision is recorded.
