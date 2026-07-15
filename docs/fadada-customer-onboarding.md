# Fadada Customer Onboarding Readiness

## Provider Document Basis

Checked local read-only Fadada PDFs under `D:\Projects\document\fadada\doc`:

- `3.2 API文档_注册账号.pdf`: `account_register.api` creates or returns a platform-scoped Fadada `customer_id`; this only proves account registration, not signing readiness.
- `3.3.1 API文档_实名认证服务_获取个人实名地址.pdf`: `get_person_verify_url.api` starts personal real-name verification and returns `transactionNo`; `cert_flag` can participate in certificate binding behavior, but the platform still needs provider evidence before signing.
- `3.3.3 API文档_实名认证服务_查询个人实名认证信息.pdf`: `find_personCertInfo.api` can confirm provider-side personal real-name status; status `2` means verification passed.
- `3.4 API文档_绑定实名信息.pdf`: `apply_cert.api` binds real-name information to the provider customer account and is required before reliable signing readiness.
- `4.6.2 查询实名流水号和认证链接.pdf`: `find_serialNo.api` can recover real-name serial/link state for a provider `customer_id`.
- `4.6.6 查询证书信息.pdf`: `query_cert.api` can confirm active certificate information for a provider customer.
- `3.7.1 API文档_合同签署_手动签署.pdf`: signing page APIs require the signer customer account to be real-name/certificate ready.
- `3.9.3` / `3.9.4` real-name callback PDFs: callbacks can update real-name status and may include certificate binding status; callback data must be verified and redacted before storage.

## Readiness Policy

Signing readiness requires all of the following:

- Fadada provider account exists and is `REGISTERED`.
- `providerCustomerId` is present.
- Real-name status is confirmed by Fadada callback or query evidence.
- Certificate binding is confirmed by `apply_cert.api`, `query_cert.api`, or callback `certStatus` evidence.
- Provider evidence is not unknown or stale.

Local `VERIFIED` alone is not signing-ready. Manual provider customer attach only binds the provider customer id; it must not set `realNameProviderVerified`, `certBound`, or `readyForSigning` without provider-backed evidence.

Docs reviewed did not show a supported automatic lookup/reuse flow by mobile phone. Do not auto-reuse a Fadada `customer_id` by mobile. If an operator manually attaches an existing provider customer id, the system must still refresh provider real-name and certificate evidence before allowing eSign.

Operator-facing remediation text should be:

`请先完成法大大实名认证并绑定实名证书`

Failed or partially validated production orders must not be reused as success evidence.

## Portal/Admin Readiness Flow

Portal contract signing must load the authenticated customer's onboarding readiness before showing or using a signing link. If readiness is not `readyForSigning=true`, the Portal must block the signing action and show the customer a remediation path to start or continue Fadada real-name verification, plus a refresh action for provider status.

When provider-backed real-name evidence is already verified but certificate binding is not confirmed, the next action is `APPLY_CERT`. Portal and Admin must not ask the customer to repeat real-name verification. The refresh action must orchestrate `apply_cert.api` and then `query_cert.api`; signing remains blocked until the refreshed readiness includes provider-backed cert-bound evidence.

The real-name verification URL is sensitive. It may be returned only by the authenticated customer's explicit Portal start/resume action. Broad status endpoints, Admin status views, audit records, logs, and provider-account list views must not expose the full URL, tokens, full ID number, or full provider identifiers.

Admin contract pages must show the same readiness gate before `发起电子签`. Admin may refresh provider-backed readiness evidence, but manual provider-customer-id attachment remains blocked until Fadada real-name and certificate binding evidence is confirmed by callback/query/apply-cert evidence.

Backend signing guards must fail closed in two places:

- before creating a Fadada eSign task
- before returning or refreshing a Portal signing URL for an existing task
