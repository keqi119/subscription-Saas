# Stage 10E-B WeChat JSAPI Payment Provider

> Date: 2026-06-17  
> Branch: `feature/stage10-wechat-jsapi-payment`  
> Scope: WeChat JSAPI payment provider, openid binding, callback verification/decryption, Portal JSAPI pay entry.

## 1. Goal

Stage 10E-B connects the Stage 10E-A `PaymentOrder` boundary to WeChat Pay JSAPI.

This stage is intentionally limited to the WeChat in-app browser scenario used by the first customer portal version: H5 pages opened from a WeChat service-account menu.

## 2. Scope

Implemented:

- `WeChatPayProvider` for JSAPI prepay creation.
- API v3 request signing with merchant private key and merchant serial number.
- JSAPI frontend pay params: `appId`, `timeStamp`, `nonceStr`, `package`, `signType`, `paySign`.
- Minimal customer WeChat openid binding after phone login.
- Protected Portal WeChat OAuth APIs.
- WeChat callback signature verification with platform public key or platform certificate.
- WeChat callback `resource` AES-256-GCM decryption with API v3 key.
- Callback idempotency through `PaymentCallbackLog` and existing `PaymentOrder` paid handling.
- Portal payment page support for `WeixinJSBridge.invoke("getBrandWCPayRequest", ...)`.

Not implemented:

- WeChat browser H5 fallback outside the WeChat client.
- Native QR code, app payment, mini-program payment, refund, invoice, automatic debit, reconciliation, or payment score.
- Any real merchant secret committed to Git.

## 3. Openid Binding

JSAPI payment requires an openid under the configured service-account AppID.

New Portal endpoints:

- `GET /api/portal/wechat/oauth-url`
- `GET /api/portal/wechat/oauth/callback`
- `GET /api/portal/wechat/binding`

The first version only binds openid to an already logged-in phone customer account. It does not replace phone-code login with WeChat one-click login.

OAuth state is HMAC signed, expires by default after 300 seconds, and only redirects back to the configured Portal base URL.

## 4. Payment Flow

1. Customer opens the payment order page in WeChat.
2. Portal calls `POST /api/portal/payment-orders/:id/pay`.
3. If `CustomerAccount.wechatOpenId` is missing, API returns `requiresWechatBinding=true` and `wechatAuthUrl`.
4. After OAuth callback binds openid, Portal retries payment.
5. API creates a WeChat JSAPI transaction with `out_trade_no = PaymentOrder.paymentOrderNo`.
6. Portal receives `jsapiParams` and calls `WeixinJSBridge.invoke`.
7. WeChat calls `POST /api/payments/callback/wechat-pay`.
8. API verifies signature, decrypts resource, validates `appid`, `mchid`, `out_trade_no`, and amount.
9. On `trade_state=SUCCESS`, existing Stage 10E-A payment completion creates `PaymentRecord`, calls `FinanceService.writeOffPayment`, updates `ReceivableBill`, and preserves DepositLedger behavior.

## 5. Env

Development defaults remain mock:

```env
PAYMENT_PROVIDER=mock
PAYMENT_MOCK_ENABLED=true
PAYMENT_DEFAULT_CHANNEL=MOCK
WECHAT_PAY_ENABLED=false
```

Production examples use JSAPI:

```env
PAYMENT_PROVIDER=wechat_pay
PAYMENT_MOCK_ENABLED=false
PAYMENT_DEFAULT_CHANNEL=WECHAT_JSAPI
WECHAT_PAY_ENABLED=true
```

Required WeChat Pay configuration:

- `WECHAT_PAY_MCH_ID`
- `WECHAT_PAY_APP_ID`
- `WECHAT_PAY_APP_SECRET`
- `WECHAT_PAY_API_V3_KEY`
- `WECHAT_PAY_MERCHANT_SERIAL_NO`
- `WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH`
- `WECHAT_PAY_MERCHANT_CERT_PATH`
- `WECHAT_PAY_PUBLIC_KEY_PATH` or `WECHAT_PAY_PLATFORM_CERT_PATH`
- `WECHAT_PAY_NOTIFY_URL`
- `WECHAT_PAY_JSAPI_AUTH_DIR`
- `WECHAT_PAY_OAUTH_REDIRECT_URI`

Secret files should live outside Git, for example:

```text
/opt/subscription-saas/secrets/wechatpay/
```

## 6. Callback Security

The callback handler stores raw JSON body for:

```text
/api/payments/callback/wechat-pay
```

Verification requires:

- `Wechatpay-Timestamp`
- `Wechatpay-Nonce`
- `Wechatpay-Signature`
- `Wechatpay-Serial`

The encrypted `resource` is decrypted with AES-256-GCM and API v3 key. Only `SUCCESS` callbacks with matching appid, mchid, amount, and out_trade_no mark the payment order paid.

## 7. Idempotency

Payment completion reuses Stage 10E-A logic:

- If `PaymentOrder.paymentStatus=PAID`, repeated callbacks only mark callback logs handled.
- `PaymentRecord` is created once.
- `PaymentWriteOff` is created once through `FinanceService.writeOffPayment`.
- Amount mismatch marks the payment order failed and does not write off bills.

## 8. Operations Notes

- The JSAPI payment authorization directory should match the Portal domain, for example `https://app.subauto.keybox.cloud/`.
- The WeChat OAuth domain must include the Portal/API callback domain used by service-account OAuth.
- The callback URL must be public HTTPS.
- Reverse proxy must forward `Wechatpay-*` headers.
- Production must keep `PAYMENT_MOCK_ENABLED=false`.
- Do not run real payment tests against production without a dedicated small-amount staging plan.

## 9. Next Stage

Recommended next step:

- `Stage 10E-B-Staging`: real WeChat Pay small-amount staging verification.

Deferred:

- `Stage 10E-C`: WeChat H5 payment fallback outside the WeChat client.

## 10. Stage 10E-B-Staging Pre-Flight Result

Stage 10E-B-Staging pre-flight was attempted on 2026-06-17 and blocked before real payment.

Report:

- `docs/stage-10e-wechat-jsapi-staging-validation.md`

Blocking items:

- `app.subauto.keybox.cloud` DNS did not resolve from the local validation environment.
- BT/Nginx did not have an `app.subauto.keybox.cloud` vhost.
- Existing production-like API/Web images predated Stage 10E-B.
- Checked server env files did not contain required `PAYMENT_*` / `WECHAT_PAY_*` values.
- No real WeChat Pay charge was initiated.

Stage 10E-B-Staging remains open until the domain, HTTPS, env, image, and small-amount test data gates are closed.
