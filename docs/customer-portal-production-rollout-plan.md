# Customer Portal Production Rollout Plan

## Goal

Roll out the Stage 10 customer Portal as a controlled release candidate on:

- H5: `https://app.subauto.keybox.cloud`
- API: `https://api.subauto.keybox.cloud/api`
- Back office: `https://admin.subauto.keybox.cloud`

The rollout should first target internal validation or invited beta users. It should not become an unrestricted real-customer launch until the RC blockers in `docs/customer-portal-release-candidate-report.md` are cleared.

## Release Scope

Included:

- Customer login.
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
- SMS notification provider.
- Native mini-program.
- Enterprise customer portal.

## Domain And Dependency Checks

Before rollout:

- `app.subauto.keybox.cloud` must serve the latest Web image over HTTPS.
- `api.subauto.keybox.cloud/api/health` must be healthy.
- `admin.subauto.keybox.cloud` must remain available for operator workflow.
- CORS and cookies must support the H5/API domain combination.
- Production route smoke must pass for `/portal/terms`, `/portal/privacy`, and `/portal/notifications`.

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
- Production must actually serve both pages before release; the 2026-06-20 route smoke found both returning 404.

## Rollout Steps

1. Confirm latest `main` includes Stage 10A through Stage 10H-B and Stage 10J documentation.
2. Build immutable Web/API images from the release commit.
3. Deploy images to production using the documented image deployment path.
4. Verify database migrations are up to date with `prisma migrate status`.
5. Do not run `prisma migrate reset` or `prisma db push`.
6. Verify H5 domain, API health, and admin domain.
7. Run production route smoke:

   ```powershell
   $env:PORTAL_BASE_URL="https://app.subauto.keybox.cloud"
   pnpm portal:route-smoke
   ```

8. Run production public API smoke:

   ```powershell
   $env:PORTAL_API_BASE_URL="https://api.subauto.keybox.cloud/api"
   pnpm portal:api-smoke
   ```

9. Run authenticated API smoke with a controlled customer cookie; do not commit or print the cookie.
10. Run WeChat menu dry-run.
11. Decide whether to apply the WeChat service-account menu.
12. Execute a controlled customer journey: login, catalog, application, materials, final plan, contract, payment, bills, service case, notifications.
13. Confirm WeChat template notification receipt/click-through.
14. Record Go / No-Go.

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
- Notification record/event failures.
- Service-case creation volume.
- Customer support issues around terms/privacy, signing, and payment.

## Go / No-Go

Current recommendation: No-Go for unrestricted production launch.

Proceed only with internal RC or invited beta after:

- Latest Web image is deployed and route smoke passes.
- Legal explicitly accepts placeholder text or formal text is deployed.
- Authenticated API smoke passes.
- Business owner explicitly accepts Mock ESignProvider for the release scope.
- WeChat menu apply decision is recorded.
