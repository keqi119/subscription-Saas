# Stage 10K-A Portal Production Login Beta Gate

Date: 2026-06-20

## Goal

Stage 10K-A closes the largest remaining customer Portal launch gate: production-grade customer login. The Portal now has an SMS provider abstraction, an Aliyun SMS implementation for login verification codes, send-result audit logs, and an invited beta access gate.

This stage does not open unrestricted production traffic. The next step is Stage 10K-A-Staging, where a controlled phone number validates real Aliyun SMS delivery.

## Why Real SMS

Stage 10A used a development-oriented verification code flow. That was sufficient for local and RC validation, but production customers need a real delivery channel that does not rely on `debugCode`.

Production now forbids `debugCode` regardless of debug env values. Development and staging can still use `debugCode` for controlled tests.

## Aliyun SMS Provider

The API package depends on the official Aliyun SMS Node.js SDK:

- `@alicloud/dysmsapi20170525`
- `@alicloud/openapi-client`
- `@alicloud/credentials`

`AliyunSmsProvider` calls `SendSms` with:

- `PhoneNumbers`: target phone
- `SignName`: `ALIYUN_SMS_SIGN_NAME`
- `TemplateCode`: `ALIYUN_SMS_LOGIN_TEMPLATE_CODE`
- `TemplateParam`: JSON containing the verification variable

The default template variable is `code` and can be overridden with `ALIYUN_SMS_TEMPLATE_CODE_VARIABLE`.

## Signature And Template Code

SMS signature and template Code must be configured through environment variables. Do not commit real values.

Required production shape:

```env
APP_ENV=production
PORTAL_SMS_PROVIDER=aliyun
PORTAL_SMS_ENABLED=true
PORTAL_SMS_DEBUG_CODE=false

ALIYUN_SMS_ACCESS_KEY_ID=<CHANGE_ME>
ALIYUN_SMS_ACCESS_KEY_SECRET=<CHANGE_ME>
ALIYUN_SMS_ENDPOINT=dysmsapi.aliyuncs.com
ALIYUN_SMS_SIGN_NAME=<CHANGE_ME>
ALIYUN_SMS_LOGIN_TEMPLATE_CODE=<CHANGE_ME>
ALIYUN_SMS_TEMPLATE_CODE_VARIABLE=code
```

## Provider Abstraction

`apps/api/src/sms/sms-provider.ts` defines:

- `SendSmsCodeInput`
- `SendSmsCodeResult`
- `SmsProvider`

Providers must not store or return plaintext verification codes in `providerResponse`. Logs and provider responses must not include AccessKey material or full provider credentials.

## Mock Provider

`MockSmsProvider` remains available for development and tests. It returns a mock message id and a sanitized response that includes the masked phone, purpose, and expiry, but not the plaintext code.

When `PORTAL_SMS_ENABLED=false`, `SmsService` records a `SKIPPED` send. The skipped send is considered usable only when the environment can expose `debugCode`; in production, where debug is never exposed, disabled SMS causes request-code to fail and the code is marked unusable.

## Send Logs

Stage 10K-A adds `SmsSendLog` with:

- masked and raw phone fields
- purpose
- provider
- send status
- provider message id / request id
- sanitized provider response
- error code / message
- optional verification code id

The migration is:

```text
20260620100000_portal_sms_send_logs
```

## DebugCode Policy

Production never returns `debugCode`.

Development and staging can still use `debugCode` for testability. The new env is `PORTAL_SMS_DEBUG_CODE`; `PORTAL_AUTH_DEBUG_CODE` remains as a legacy compatibility switch, but production still suppresses debug output even if either is set.

Use `APP_ENV` to distinguish deployment intent from Node runtime mode. Staging may keep `NODE_ENV=production` for optimized runtime behavior while setting `APP_ENV=staging` to allow controlled debug-code testing.

## Beta Access Gate

The customer Portal now supports an invited beta gate:

```env
PORTAL_BETA_MODE=true
PORTAL_BETA_ALLOWED_PHONES=<CHANGE_ME_COMMA_SEPARATED>
```

When beta mode is enabled, only allowlisted phone numbers can request or use login codes. The customer-facing rejection message is:

```text
当前客户门户处于受邀试运行阶段，请联系工作人员开通。
```

The whitelist parser accepts plain mainland mobile numbers and `+86` / `86` / `0086` prefixes. Do not commit real invited phone numbers.

## Request-Code Flow

`POST /api/portal/auth/request-code` now:

1. Normalizes the phone.
2. Checks beta access.
3. Preserves the existing resend window.
4. Generates a 6-digit code.
5. Stores only the hash.
6. Calls `SmsService.sendLoginCode`.
7. Records the SMS send result.
8. Returns `debugCode` only outside production.
9. Marks the verification code unusable when SMS send fails.

The existing 5-minute expiry, 60-second resend window, and max-attempt login checks remain in place.

## Not In This Stage

Stage 10K-A does not implement:

- SMS marketing
- mass SMS send
- batch send
- notification-center SMS provider
- WeChat one-click login
- WeChat-outside H5 payment
- real e-sign provider
- payment, write-off, billing, entitlement, service-case, WeChat Pay, certificate-rotation, or WeChat template-message business logic changes
- production deployment

## Stage 10K-B

After Stage 10K-A-Staging confirms real SMS delivery, beta allowlist behavior, `SmsSendLog` request ids, no debugCode in production-like config, and no secret leakage, the project can move to Stage 10K-B Controlled Beta Rollout.
