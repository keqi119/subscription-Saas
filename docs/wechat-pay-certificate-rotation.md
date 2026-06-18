# WeChat Pay Platform Certificate Rotation

> Scope: WeChat Pay API v3 platform certificate rotation for JSAPI payment callback verification.

## 1. Certificate Types

- Merchant API certificate: owned by the merchant. The API service uses the merchant private key and merchant certificate serial number to sign outbound WeChat Pay API requests.
- WeChat Pay platform certificate or public key: owned by WeChat Pay. The API service uses it to verify WeChat Pay callback and response signatures.

This runbook is for WeChat Pay platform certificate rotation. Do not change the merchant private key, merchant certificate, or `WECHAT_PAY_MERCHANT_SERIAL_NO` unless WeChat Pay explicitly asks for merchant certificate rotation.

## 2. Why Multi-Certificate Verification Is Required

During platform certificate gray release, WeChat Pay may sign callbacks with either the old platform certificate or the new one. The callback header `Wechatpay-Serial` identifies which platform certificate was used.

The API must select the verification certificate by `Wechatpay-Serial`. If the serial is unknown, the callback must be logged as unverified and must not mark `PaymentOrder` as paid.

## 3. Configuration

Legacy single-certificate configuration remains supported:

```env
WECHAT_PAY_PLATFORM_CERT_PATH=/opt/subscription-saas/secrets/wechatpay/wechatpay_platform_cert.pem
```

Recommended rotation configuration:

```env
WECHAT_PAY_PLATFORM_CERTS=<OLD_SERIAL>:/opt/subscription-saas/secrets/wechatpay/platform-certs/old.pem,<NEW_SERIAL>:/opt/subscription-saas/secrets/wechatpay/platform-certs/new.pem
```

When `WECHAT_PAY_PLATFORM_CERTS` is present, it takes precedence over `WECHAT_PAY_PUBLIC_KEY_PATH` and `WECHAT_PAY_PLATFORM_CERT_PATH` for callback verification.

Do not put real serials, certificates, API v3 keys, merchant private keys, or AppSecret values in Git.

## 4. Server File Layout

Recommended server path:

```text
/opt/subscription-saas/secrets/wechatpay/platform-certs/
```

Example:

```text
/opt/subscription-saas/secrets/wechatpay/platform-certs/old-<serial>.pem
/opt/subscription-saas/secrets/wechatpay/platform-certs/new-<serial>.pem
```

Permissions:

```bash
chmod 700 /opt/subscription-saas/secrets/wechatpay/platform-certs
chmod 600 /opt/subscription-saas/secrets/wechatpay/platform-certs/*.pem
```

## 5. Rotation Steps

1. Upload the old and new platform certificates to the server without overwriting either file.
2. Configure `WECHAT_PAY_PLATFORM_CERTS` with old and new serial/path pairs.
3. Restart the API container.
4. Run a 0.01 CNY JSAPI payment before starting gray release; confirm callback `verified=true` and `handled=true`.
5. Start manual gray release in WeChat Pay merchant platform at a small percentage, for example 1%.
6. Run another 0.01 CNY payment and check `PaymentCallbackLog`.
7. Watch for `WECHATPAY_SERIAL_NOT_CONFIGURED`, `WECHATPAY_SIGNATURE_VERIFY_FAILED`, or `WECHATPAY_VERIFIER_CERT_READ_FAILED`.
8. If callback verification is healthy, raise gray percentage gradually, for example 10%, 50%, then 100%.
9. Keep the old platform certificate configured for 24-48 hours after 100% new certificate traffic is stable.
10. Remove the old certificate in a later maintenance window only after no callbacks use the old serial.

## 6. Failure Handling

If any callback verification failure appears during gray release:

- Stop the WeChat Pay platform certificate gray release immediately.
- Keep the old certificate file and old serial mapping.
- Check `Wechatpay-Serial`, certificate file path, file permissions, raw body handling, and proxy forwarding of `Wechatpay-*` headers.
- Do not mark payment orders paid from unverified callbacks.

## 7. Current Code Behavior

- `WECHAT_PAY_PLATFORM_CERTS` supports multiple `serial:path` pairs.
- Callback verification selects the configured certificate by `Wechatpay-Serial`.
- Unknown serial returns `verified=false` and records `WECHATPAY_SERIAL_NOT_CONFIGURED`.
- Signature failure returns `verified=false` and records `WECHATPAY_SIGNATURE_VERIFY_FAILED`.
- Legacy `WECHAT_PAY_PUBLIC_KEY_PATH` and `WECHAT_PAY_PLATFORM_CERT_PATH` remain supported when no mapping is configured.
- WeChat Pay API response signature verification is not currently implemented; this change covers callback verification.

## 8. Deferred

- Automatic platform certificate download is not implemented.
- Real-time certificate refresh without API restart is not implemented.
- Merchant API certificate rotation is out of scope.
