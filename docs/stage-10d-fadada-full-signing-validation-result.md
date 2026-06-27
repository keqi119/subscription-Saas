# Stage 10D-B5-B Fadada Full Signing Validation Result

> Scope: single controlled Fadada full signing execution attempt.
> Date: 2026-06-27
> Result: blocked before any provider call.

## 1. Execution Approval

The user approved entering Stage 10D-B5-B with these boundaries:

- opening the generated sign URL: approved;
- completing signing by the current verified tester: approved;
- allowing callback to advance contract/order: approved;
- allowing signed PDF archive: approved;
- accepting Fadada official backend records / possible fee: approved;
- using `FADADA_FULL_SIGNING_SMOKE` override: approved;
- automatic platform seal: **not approved**.

No `extsign_auto.api` call is allowed in this stage.

## 2. Safety Check Result

| Check | Result |
| --- | --- |
| Branch | `feature/stage10-fadada-production-upload-signurl-smoke-run` |
| Worktree | clean before execution attempt |
| `.env.fadada.production.local` ignored | yes |
| `.tmp` ignored | yes |
| `FADADA_AUTO_SIGN_ENABLED` | missing / effectively disabled |

No `.env`, `.tmp`, secret, full customer id, full sign URL, PII, PDF binary, or provider raw response was committed.

## 3. Env Preflight Result

The generic production upload/signUrl preflight passed:

```text
pnpm fadada:upload-signurl:preflight
preflight=passed
uploaddocs=skipped
extsign_validation=skipped
```

B5-B-specific full signing gates did **not** pass:

| Field | Result |
| --- | --- |
| `FADADA_ENV` | production |
| `FADADA_BASE_URL` | HTTPS present |
| `FADADA_ENABLED` | true |
| `FADADA_PRODUCTION_SMOKE` | `1` |
| `FADADA_FULL_SIGNING_SMOKE` | missing |
| `FADADA_TEST_LOCAL_CUSTOMER_ID` | missing |
| `FADADA_TEST_CUSTOMER_ID` | present |
| `FADADA_APP_ID` | present |
| `FADADA_APP_SECRET` | present |
| `FADADA_SIGN_NOTIFY_URL` | HTTPS present |
| `FADADA_SIGN_RETURN_URL` | HTTPS present |

## 4. Blocker

B5-B was stopped before creating any sign task because the resolver safety gates were incomplete:

```text
FADADA_FULL_SIGNING_SMOKE is missing
FADADA_TEST_LOCAL_CUSTOMER_ID is missing
```

The formal Fadada provider path must not continue without these values because local `Customer.id` must never be used as a Fadada `customer_id`.

## 5. Execution Result

| Step | Result |
| --- | --- |
| Target callback DB confirmation | not executed |
| Test sample selection / creation | not executed |
| `createSignTask` | not executed |
| `uploaddocs.api` | not called |
| `extsign_validation.api` | not called |
| sign URL generated | no |
| sign URL opened | no |
| signing completed | no |
| automatic seal | no |
| callback received | no |
| contract/order advanced | no |
| signed PDF archive | not executed |
| Admin PDF stream | not executed |
| Portal PDF stream | not executed |
| business database write | no |

## 6. Finance / Side Effect Result

No signing flow was executed, so no finance-side data should have changed.

| Area | Result |
| --- | --- |
| PaymentOrder | not touched |
| PaymentRecord | not created |
| PaymentWriteOff | not created |
| ReceivableBill | not touched |
| DepositLedger | not touched |
| ROE / BaaS / depreciation | not touched |

## 7. Required Next Action

Before retrying B5-B, configure the ignored local env file with:

```env
FADADA_FULL_SIGNING_SMOKE=1
FADADA_TEST_LOCAL_CUSTOMER_ID=<controlled local test Customer.id in the callback target DB>
```

Then re-run the B5-B preflight and confirm:

1. `FADADA_TEST_LOCAL_CUSTOMER_ID` points to the controlled local test customer;
2. that customer exists in the same database used by the callback URL;
3. `FADADA_TEST_CUSTOMER_ID` is the verified Fadada provider customer id for the same tester;
4. automatic seal remains disabled.

## 8. R1 Preflight Retry

After `FADADA_TEST_LOCAL_CUSTOMER_ID` was filled from the controlled tester customer, B5-B-R1 was attempted again.

Local env safety gates:

| Field | Result |
| --- | --- |
| `FADADA_FULL_SIGNING_SMOKE` | `1` |
| `FADADA_TEST_LOCAL_CUSTOMER_ID` | present |
| `FADADA_TEST_CUSTOMER_ID` | present |
| `FADADA_AUTO_SIGN_ENABLED` | `false` |
| generic upload/signUrl preflight | passed |

Controlled local customer check:

| Check | Result |
| --- | --- |
| masked mobile | `186****0212` |
| production DB customer match | exactly one |
| local customer id | present / masked |
| customer status | approved |

Callback target API / DB check:

| Field | Result |
| --- | --- |
| target callback URL | `https://api.subauto.keybox.cloud/api/esign/callback/fadada` |
| target API container | production API |
| target DB | `subscription_saas_prod`, masked connection |
| API `NODE_ENV` | production |
| API `DATABASE_URL` | present, points to `postgres:5432/subscription_saas_prod` |
| API `ESIGN_PROVIDER` | missing |
| API `FADADA_ENV` | missing |
| API `FADADA_BASE_URL` | missing |
| API `FADADA_ENABLED` | missing |
| API `FADADA_APP_ID` / `FADADA_APP_SECRET` | not present in inspected Fadada env set |

### R1 Blocker

B5-B-R1 stopped before sample selection or `createSignTask`.

Reason:

```text
callback target API is not configured for the Fadada provider
```

The callback controller injects the configured e-sign provider. Without `ESIGN_PROVIDER=fadada` and the Fadada credentials/config in the callback target API environment, a real Fadada callback cannot be reliably verified and handled by the production API.

No sign task was created. No Fadada API was called. No sign URL was opened. No signing was completed. No contract/order/payment/archive state changed.

Required next action before another B5-B attempt:

```text
Configure the callback target API environment for Fadada:
ESIGN_PROVIDER=fadada
FADADA_ENV=production
FADADA_BASE_URL=https://textapi.fadada.com/api2/
FADADA_ENABLED=true
FADADA_APP_ID=<present>
FADADA_APP_SECRET=<present>
FADADA_SIGN_NOTIFY_URL=https://api.subauto.keybox.cloud/api/esign/callback/fadada
FADADA_SIGN_RETURN_URL=https://app.subauto.keybox.cloud/portal/contracts
FADADA_FULL_SIGNING_SMOKE=1
FADADA_TEST_LOCAL_CUSTOMER_ID=<controlled local test Customer.id>
FADADA_TEST_CUSTOMER_ID=<verified Fadada tester customer_id>
FADADA_AUTO_SIGN_ENABLED=false or missing
```

After updating server env, restart/redeploy the API container and re-check the callback target API env with masked output before any signing attempt.

## 9. Stage 10D-B5-B-ENV Runtime Config Preflight

Stage 10D-B5-B-ENV was run as a configuration/readiness preflight only. It did not deploy, restart, create a task, call Fadada, open a sign URL, sign, advance state, or archive a PDF.

### 9.1 Production API Image / Code Check

Current production API container:

| Field | Result |
| --- | --- |
| container | `subauto-production-api-1` |
| status | healthy |
| image | `ghcr.io/keqi119/subscription-api:portal-rc-r6-20260620-4188aec` |
| image created | 2026-06-20 |
| compose project | `subauto-production` |
| compose env file | `/opt/subscription-saas/.env.production.images` |
| compose config | `/opt/subscription-saas/docker-compose.production.images.example.yml` |

Code capability search inside the running container:

| Check | Result |
| --- | --- |
| `/app/apps/api/dist/src/esign/fadada` | missing |
| `resolveFadadaSignerCustomerId` string | missing |
| `FADADA_FULL_SIGNING_SMOKE` string | missing |
| `FADADA_TEST_LOCAL_CUSTOMER_ID` string | missing |
| `extsign_validation.api` string | missing |
| visible e-sign provider files | only base/mock e-sign files found |

Conclusion:

```text
production API image does not contain PR #123 Fadada provider/runtime code
```

This blocks B5-B-ENV. Do not configure only env on this image, because `ESIGN_PROVIDER=fadada` is not expected to work without the deployed Fadada provider code.

### 9.2 Runtime Env Check

The previous masked production API env check also showed:

```text
ESIGN_PROVIDER missing
FADADA_ENV missing
FADADA_BASE_URL missing
FADADA_ENABLED missing
FADADA_APP_ID / FADADA_APP_SECRET not present in inspected Fadada env set
```

These env gaps remain secondary to the image/code blocker above.

### 9.3 Health / Callback Probe

Skipped.

Reason:

```text
image/code gate failed
```

No invalid-digest callback probe was sent, because the running image does not contain the Fadada callback verifier/provider code required for this stage.

### 9.4 Target DB / Customer Mapping

The target production DB and controlled customer were already checked in B5-B-R1:

- target DB: `subscription_saas_prod`, masked;
- masked mobile: `186****0212`;
- customer match: exactly one;
- local customer id: present / masked;
- provider customer id: present / masked in ignored local env.

No business data was written.

### 9.5 ENV Gate Decision

Stage 10D-B5-B-ENV passed: **no**.

Required next decision:

```text
Option A: build and deploy a PR #123 API candidate image to api.subauto.keybox.cloud, then configure Fadada runtime env and re-run B5-B-ENV.
Option B: use a staging API callback URL that runs PR #123 code, and have Fadada allow that staging notify_url before B5-B.
```

Do not proceed to B5-B execution on the current production API image.

## 10. Current Gate

Stage 10D-B5-B passed: **no**.

Stage 10D-B5-B may be retried only after the callback target API runs PR #123 Fadada code and the masked runtime env preflight passes.
