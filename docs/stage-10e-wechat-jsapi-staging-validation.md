# Stage 10E-B-Staging WeChat JSAPI Payment Validation

> Date: 2026-06-17  
> Branch: `feature/stage10-wechat-jsapi-staging-validation`  
> Result: blocked before real payment. No real WeChat Pay charge was initiated.

> Update: 2026-06-18. `app.subauto.keybox.cloud` now has DNS and a valid
> HTTPS certificate, but the server-side vhost still returned the BT static
> 404 page during validation and must be changed to proxy the Web container.

> Update: 2026-06-18 second pass. The operator reported that the Docker image
> workflow step was handled manually. Server deployment could not continue from
> Codex because new SSH sessions to `139.196.227.195:22` returned network-level
> `Permission denied` even after the tunnel was restarted and low-frequency
> retries were attempted.

## 1. Scope

This report records the pre-flight validation for a real small-amount WeChat Pay JSAPI test after Stage 10E-B.

The intended validation path is:

1. customer opens Portal from `https://app.subauto.keybox.cloud`;
2. customer logs in by phone;
3. customer binds WeChat openid under the service-account AppID;
4. Portal creates a `WECHAT_JSAPI` `PaymentOrder`;
5. WeixinJSBridge opens the WeChat cashier;
6. WeChat Pay callback reaches `POST /api/payments/callback/wechat-pay`;
7. callback verification and AES-256-GCM resource decryption pass;
8. `PaymentOrder` becomes `PAID`;
9. existing finance logic creates `PaymentRecord` and `PaymentWriteOff`.

## 2. Secret Handling

Local preparation file checked read-only:

```text
D:\WXCertUtil\wxchatpay-prepare-h5-chatgpt-v1.txt
```

The file content was not copied into the repository. No AppSecret, APIv3 key, merchant private key, certificate content, full mchid, full openid, or full transaction ID is recorded in this report.

## 3. Material Completeness

Masked status:

| Item | Status |
| --- | --- |
| mchid | prior masked value `526****611`; not reprinted in full |
| service-account AppID | operator-provided, masked as `wx****0c3d` |
| AppSecret | present |
| APIv3 key | present |
| merchant API certificate serial number | operator-provided, masked as `****0F9CC` |
| merchant private key file | present locally |
| merchant API certificate file | present locally |
| platform certificate or WeChat Pay public key | present locally, masked path only |
| notify URL | `https://api.subauto.keybox.cloud/api/payments/callback/wechat-pay` |
| JSAPI auth directory | `https://app.subauto.keybox.cloud/` |
| OAuth redirect URI | expected `https://api.subauto.keybox.cloud/api/portal/wechat/oauth/callback`; not found by local file parser |

Execution rule:

- Do not start real payment until the server env contains all required values.
- Do not start real payment until `app.subauto.keybox.cloud` resolves and has working HTTPS.

## 4. Local Release Gate

Local branch was created from `main` after Stage 10E-B was merged.

Pre-flight command:

```powershell
pnpm release:check
```

Result:

- Passed.
- Prisma validate/generate passed.
- Workspace lint passed.
- API/Web typecheck passed.
- API tests passed: 38 files / 584 tests.
- Prisma migrate status: database schema is up to date.

## 5. Domain And Public Entry Check

Local public checks:

| Check | Result |
| --- | --- |
| `app.subauto.keybox.cloud` DNS | resolves to `139.196.227.195` after operator update |
| `api.subauto.keybox.cloud` DNS | resolves to `139.196.227.195` |
| `admin.subauto.keybox.cloud` DNS | resolves to `139.196.227.195` |
| public TCP `139.196.227.195:80` | failed from local environment |
| public TCP `139.196.227.195:443` | failed from local environment |
| `https://api.subauto.keybox.cloud/api/health` | not reachable from local environment |
| `https://app.subauto.keybox.cloud/portal` | not reachable from local environment |

Server-side checks over SSH:

| Check | Result |
| --- | --- |
| Nginx listening on `0.0.0.0:80` | yes |
| Nginx listening on `0.0.0.0:443` | yes |
| Web container on `127.0.0.1:3000` | yes |
| API container on `127.0.0.1:3001` | yes |
| Nginx syntax | passed |
| server-local API health through HTTPS vhost | passed |
| server-local app Portal through HTTPS vhost | failed with `HTTP/2 404` from BT static site |
| `app.subauto.keybox.cloud` certificate | present and valid for `app.subauto.keybox.cloud` |
| existing production Web image | `prod-20260615-5e8d04a` |
| existing production API image | `prod-20260615-5e8d04a` |
| contains Stage 10E-B | no, image predates Stage 10E-B |

## 6. Nginx / Customer Domain Check

Existing BT/Nginx vhosts include:

- `admin.subauto.keybox.cloud`
- `api.subauto.keybox.cloud`
- `app.subauto.keybox.cloud`
- `subauto.keybox.cloud`
- staging admin/API domains

`app.subauto.keybox.cloud` vhost now exists and has a valid HTTPS certificate,
but it was still configured as a BT static site during validation. A
server-local request to `/portal` returned `HTTP/2 404` instead of the Portal
page from the Web container.

Blocker:

- JSAPI payment page must be opened from `https://app.subauto.keybox.cloud/portal/payment-orders/{id}`.
- Current Nginx state cannot serve that URL until the vhost proxies to `127.0.0.1:3000`.

## 7. Server Env Check

Checked server-side env files without printing values:

- `/opt/subscription-saas/.env.production.images`
- `/opt/subscription-saas/.env.staging.images`

Required payment keys were missing in the checked files:

- `PAYMENT_PROVIDER`
- `PAYMENT_DEFAULT_CHANNEL`
- `PAYMENT_MOCK_ENABLED`
- `WECHAT_PAY_ENABLED`
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
- `PORTAL_BASE_URL`
- `API_BASE_URL`
- `WECHAT_PAY_SECRET_DIR`

Blocker:

- Real JSAPI prepay cannot be attempted until these are set server-side.
- The API container must also mount `/opt/subscription-saas/secrets/wechatpay/`
  read-only so the WeChat Pay provider can read the merchant private key and
  platform certificate/public key.

## 8. Payment Execution

Real WeChat Pay connection:

- Not executed.

Real charge:

- Not executed.

Charge amount:

- `0.00 CNY`.

Reason:

- Pre-flight blockers prevent a safe real payment attempt.

## 9. Validation Items Not Reached

The following were not executed:

- customer Portal login on `app.subauto.keybox.cloud`;
- WeChat OAuth openid binding;
- `GET /api/portal/wechat/binding`;
- payable bill creation for a 1-fen test case;
- `POST /api/portal/payment-orders`;
- `POST /api/portal/payment-orders/:id/pay`;
- WeixinJSBridge cashier invocation;
- WeChat callback receipt;
- callback signature verification;
- AES-256-GCM resource decryption;
- `PaymentOrder=PAID`;
- `PaymentRecord` / `PaymentWriteOff` creation from real callback;
- `ReceivableBill` settlement;
- `DepositLedger.COLLECT`.

## 10. Blocker Closure Checklist

Before retrying Stage 10E-B-Staging:

- [x] Add DNS record: `app.subauto.keybox.cloud -> 139.196.227.195`.
- [x] Configure a valid HTTPS certificate for `app.subauto.keybox.cloud`.
- [ ] Change BT/Nginx HTTPS vhost for `app.subauto.keybox.cloud -> 127.0.0.1:3000`.
- [ ] Ensure public `80/443` reachability from an external network.
- [ ] Configure WeChat public-platform OAuth domain for `app.subauto.keybox.cloud`.
- [ ] Configure JSAPI payment auth directory: `https://app.subauto.keybox.cloud/`.
- [ ] Configure server-only env with `PAYMENT_PROVIDER=wechat_pay`, `PAYMENT_DEFAULT_CHANNEL=WECHAT_JSAPI`, and all `WECHAT_PAY_*` values.
- [ ] Copy merchant private key, merchant cert, and platform cert/public key to `/opt/subscription-saas/secrets/wechatpay/` with `chmod 600`.
- [ ] Mount `/opt/subscription-saas/secrets/wechatpay/` into the API container read-only.
- [ ] Deploy API/Web images that include Stage 10E-B. The image build workflow
  was handled manually, but server pull/up was not verified in this pass.
- [ ] Verify Web bundle contains `https://api.subauto.keybox.cloud/api` and does not contain staging API domains.
- [ ] Re-run `pnpm release:check`.
- [ ] Create a 1-fen test bill for a non-production test customer only.

## 11. Decision

Stage 10E-B-Staging is blocked before real payment.

It is not safe to announce real JSAPI payment validation passed.

Next action:

- fix domain / Nginx / env / image blockers, then rerun this validation.
