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

## 11. Stage 10D-B5-B-ENV-A Production API Candidate Deployment And Callback Readiness

Stage 10D-B5-B-ENV-A was run as an API-only production candidate deployment and callback readiness check. It did not open a sign URL, sign, create a real `ContractESignTask`, call Fadada upload/signUrl/sign/download/filing APIs, seed production, migrate production, deploy Web, or intentionally advance contract/order/payment state.

### 11.1 Candidate Image

| Field | Result |
| --- | --- |
| source commit | `214576bbb539b9b22ca255fa6394050c64293d94` |
| image tag | `ghcr.io/keqi119/subscription-api:fadada-pr123-20260627-214576b` |
| image repo digest | `sha256:99312563a13410c529604d28ff37a4df960a657d62336de70eeaea0f01250fb5` |
| remote image id | `sha256:781d26cca7809ee6251c1db230cb45bc5bbeb981cf7016537c0983b53a393e22` |
| build time | `2026-06-27T13:59:44Z` |
| GHCR push | passed |

### 11.2 Production Backup And Predeploy Env

| Field | Result |
| --- | --- |
| previous API image | `ghcr.io/keqi119/subscription-api:portal-rc-r6-20260620-4188aec` |
| previous API repo digest | `sha256:bf10d831a24fa99abee7a8ba915bf18b0ae958b374e04c0a09a404c09c74e9fc` |
| previous API image id | `sha256:a315f90e1cae481471bd47666609a63ab781c743f3b0419dc872d0376566c1b3` |
| compose env file | `/opt/subscription-saas/.env.production.images` |
| compose file | `/opt/subscription-saas/docker-compose.production.images.example.yml` |
| predeploy backup | `/opt/subscription-saas/deploy-backups/fadada-pr123-20260627-220602` |
| pre-Fadada env backup | `/opt/subscription-saas/deploy-backups/fadada-pr123-env-before-20260627-220900.env` |
| API switch backup | `/opt/subscription-saas/deploy-backups/fadada-pr123-api-switch-20260628-003038` |

Masked predeploy runtime env readiness passed before the API switch:

```text
ESIGN_PROVIDER=fadada
FADADA_ENV=production
FADADA_BASE_URL=https://textapi.fadada.com/api2/
FADADA_API_VERSION=2.0
FADADA_ENABLED=true
FADADA_APP_ID=present
FADADA_APP_SECRET=present
FADADA_SIGN_NOTIFY_URL=https://api.subauto.keybox.cloud/api/esign/callback/fadada
FADADA_SIGN_RETURN_URL=https://app.subauto.keybox.cloud/portal/contracts
FADADA_FULL_SIGNING_SMOKE=1
FADADA_TEST_LOCAL_CUSTOMER_ID=present
FADADA_TEST_CUSTOMER_ID=present
FADADA_AUTO_SIGN_ENABLED=false
FADADA_UPLOAD_SIGNURL_SMOKE=0
FADADA_TEST_SIGNER_REALNAME_PREP=0
```

### 11.3 API-Only Deployment

Deployment executed: **yes**.

Only the API service was recreated:

```text
docker compose -p subauto-production --env-file .env.production.images -f docker-compose.production.images.example.yml up -d --no-deps api
```

No Web restart, Postgres restart, seed, migration, `migrate reset`, or `db push` was executed.

Post-deploy API health before the callback probe:

| Field | Result |
| --- | --- |
| API image | `ghcr.io/keqi119/subscription-api:fadada-pr123-20260627-214576b` |
| API image id | `sha256:781d26cca7809ee6251c1db230cb45bc5bbeb981cf7016537c0983b53a393e22` |
| container status | running |
| container health | healthy |
| public health | `200`, `status:"ok"`, `storage:"oss"` |

### 11.4 Callback Invalid Digest Probe

Probe:

```text
POST https://api.subauto.keybox.cloud/api/esign/callback/fadada
transaction_id=probe
contract_id=probe
result_code=3000
timestamp=20260101000000
msg_digest=invalid
```

Result:

| Field | Result |
| --- | --- |
| endpoint exists | yes |
| status code | `500` |
| body summary | generic internal server error |
| expected readiness | failed |
| business advancement | no task/signer/callback-log row for `probe` |

The API log showed the root cause:

```text
Prisma P2022 ColumnNotFound:
column subscription_order.model_definition_id_snapshot does not exist
```

The callback code path queried `ContractESignSigner` and joined through relations that require PR #123/current schema fields. Production DB is behind the candidate image schema, so invalid-digest callback readiness failed before the digest rejection response could be returned.

### 11.5 Production Migration Status

Read-only `prisma migrate status` was run from the candidate image against production DB without deploying it again after rollback. Result: **not up to date**.

Unapplied migrations:

```text
20260620100000_portal_sms_send_logs
20260621100000_vehicle_listing_profiles
20260621110000_vehicle_condition_reports
20260622160000_customer_profile_materials
20260622190000_vehicle_insurance_documents_claims
20260622210000_vehicle_baas_contracts
20260623090000_vehicle_depreciation_policies
20260623170000_vehicle_model_codes
20260624090000_vehicle_model_definitions
20260624110000_vehicle_model_definition_on_vehicle
20260624123000_product_model_definition_links
20260624170000_residual_model_definition_links
20260624193000_quote_order_model_snapshots
20260624203000_quote_order_model_code_snapshots
```

No production migration was applied in this stage.

### 11.6 Target DB / Customer Mapping

Read-only production DB mapping check passed:

| Check | Result |
| --- | --- |
| `FADADA_TEST_LOCAL_CUSTOMER_ID` customer count | `1` |
| masked mobile `186****0212` customer count | `1` |
| same customer | yes |
| `FADADA_TEST_CUSTOMER_ID` | present |

No full local customer id, provider customer id, mobile number, app secret, sign URL, or PII was printed or recorded.

### 11.7 Rollback

Rollback executed: **yes**.

Reason:

```text
callback invalid digest probe returned 500 because production DB schema is not up to date for the PR #123 candidate image
```

Rollback restored the pre-Fadada production env backup and previous API image:

| Field | Result |
| --- | --- |
| rollback dir | `/opt/subscription-saas/deploy-backups/fadada-pr123-rollback-20260628-003308` |
| rollback image | `ghcr.io/keqi119/subscription-api:portal-rc-r6-20260620-4188aec` |
| rollback image id | `sha256:a315f90e1cae481471bd47666609a63ab781c743f3b0419dc872d0376566c1b3` |
| API health after rollback | healthy |
| public health after rollback | `200`, `status:"ok"`, `storage:"oss"` |

Current production API is not running the PR #123 candidate after rollback.

### 11.8 Gate Decision

Stage 10D-B5-B-ENV-A passed: **no**.

B5-B execution is blocked by production schema drift:

```text
production DB is not up to date for the PR #123 API candidate image
```

Do not proceed to B5-B execution until a separate, approved production migration plan brings `subscription_saas_prod` up to the schema required by the PR #123 candidate image, followed by a new API candidate deploy and callback invalid-digest readiness probe.

## 12. Stage 10D-B5-B-H1 Fadada Callback Invalid-Digest Hardening

Stage 10D-B5-B-H1 addresses the ENV-A invalid-digest failure mode in code only. It does not deploy production, apply production migrations, call Fadada, open a sign URL, sign, archive a PDF, seed data, or advance contract/order/payment state.

### 12.1 Root Cause

ENV-A showed that the callback service verified the Fadada digest first, but still called task lookup before returning the unverified response. The lookup path queried `ContractESignSigner` / `ContractESignTask` with relation includes that reached `SubscriptionOrder`; on the old production schema this triggered:

```text
Prisma P2022 ColumnNotFound:
subscription_order.model_definition_id_snapshot
```

### 12.2 H1 Behavior

For `verified=false` callbacks:

- return `handled=false`, `reason=UNVERIFIED` before signer/task/contract/order lookup;
- do not call the Fadada business callback handler;
- do not update signer, task, contract, order, payment, write-off, bill, archive, ROE, BaaS, or depreciation state;
- sanitize `download_url` and `viewpdf_url` before any log write;
- write a `verified=false` callback log on a best-effort basis;
- if the callback log write/update fails, still return the unverified response instead of propagating a 500.

### 12.3 Remaining Gate

H1 is not sufficient to enter B5-B execution. Production still needs migration preflight and an approved no-seed production migration apply before the PR #123 candidate API can safely run against `subscription_saas_prod`.

Next required stage:

```text
Stage 10D-B5-B-MIGRATION-PREFLIGHT
```

### 12.4 Local Verification

H1 local gates passed:

```text
pnpm --filter @subscription-saas/api exec vitest run test/esign.spec.ts
19 tests passed

pnpm -r lint
passed

pnpm prisma:validate
passed

pnpm prisma:generate
passed

pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
passed

pnpm --filter @subscription-saas/api test
61 files / 838 tests passed

pnpm release:check
passed on isolated local PostgreSQL 127.0.0.1:55432/subscription_saas
```

No remote or production database seed was executed.

## 13. Stage 10D-B5-B-MIGRATION-PREFLIGHT Result

Stage 10D-B5-B-MIGRATION-PREFLIGHT is recorded in `docs/stage-10d-fadada-production-migration-preflight.md`.

Result summary:

- H1 commit `df4d33d` is now pushed to the PR #123 branch.
- Production read-only migration status shows 40 applied migrations and 14 pending migrations.
- A new production backup was created at `/opt/subscription-saas/backups/subscription_saas_prod_20260628142508.dump`.
- Backup validation passed with `pg_restore -l`.
- The backup restored successfully into isolated clone `subauto-migration-preflight-20260628142508-postgres`.
- Clone `prisma migrate deploy` applied all 14 pending migrations in 5 seconds.
- Clone migration status is up to date with 54 migrations.
- Temporary candidate API health on clone passed.
- Invalid digest callback against the clone returned non-500 with `UNVERIFIED` and did not create task/signer rows.

Important caveat:

```text
The API image used for the clone probe was ghcr.io/keqi119/subscription-api:fadada-pr123-20260627-214576b.
That image was built from 214576b and does not contain H1.
```

Before production redeploy, build a new API candidate image from `df4d33d` or later.

No production migration, production seed, production API deployment, Fadada API call, sign URL opening, signing, task creation, contract/order advancement, payment posting, write-off, or bill mutation was executed.

Current gate:

```text
production migration apply approval can be discussed
B5-B execution remains blocked
```

## 14. Stage 10D-B5-B-MIGRATION-APPLY Result

Stage 10D-B5-B-MIGRATION-APPLY is recorded in `docs/stage-10d-fadada-production-migration-apply.md`.

Result summary:

- fresh pre-apply backup created and validated:
  `/opt/subscription-saas/backups/subscription_saas_prod_20260628150152_pre_migrate_apply.dump`;
- backup size: 641582 bytes;
- backup sha256: `e0c20c0e1143c3f098bbb2f11dc5de03cb93fefd9c9851bfe09793fd77a3bcdb`;
- `pg_restore -l`: success;
- production no-seed `prisma migrate deploy`: success;
- applied migrations: 14;
- production migrate status: up to date, 54 migrations;
- production seed: not executed;
- API candidate deploy: not executed;
- Fadada API calls/signing/task creation/contract/order/payment changes: not executed;
- old production API image remained running and healthy.

Current gate:

```text
production migration blocker: closed
next stage: rebuild H1 API candidate and perform API-only callback readiness deployment
B5-B execution: still blocked
```

## 15. Stage 10D-B5-B-ENV-B Candidate Redeploy And Callback Readiness

Stage 10D-B5-B-ENV-B rebuilt and deployed a PR #123 API candidate that includes H1 callback hardening.

### 15.1 Candidate Image

| Field | Result |
| --- | --- |
| source commit | `e4bf95907bd4cae942f8db12bc79c00a0da5daa5` |
| contains H1 commit | yes, includes `df4d33d fix: reject invalid fadada callbacks before business lookup` |
| image tag | `ghcr.io/keqi119/subscription-api:fadada-pr123-envb-20260628-e4bf959` |
| image digest | `sha256:13f0d2dc30776f487f4c4bd1ca23007f4ae09ad17a6c3bfc2105a7c9659e5514` |
| build result | success |
| GHCR push result | success |

Local branch note:

```text
The local source commit e4bf959 contains documentation only after H1.
GitHub push for e4bf959 failed due network reset, but the GHCR image was built from local HEAD and includes H1.
```

### 15.2 Deployment

| Field | Result |
| --- | --- |
| deployment executed | yes |
| deployment type | API-only |
| compose project | `subauto-production` |
| API service | `api` / `subauto-production-api-1` |
| pre-deploy backup | `/opt/subscription-saas/deploy-backups/fadada-envb-20260628174342` |
| previous API image | `ghcr.io/keqi119/subscription-api:portal-rc-r6-20260620-4188aec` |
| previous API digest | `sha256:bf10d831a24fa99abee7a8ba915bf18b0ae958b374e04c0a09a404c09c74e9fc` |
| rollback image | `ghcr.io/keqi119/subscription-api:portal-rc-r6-20260620-4188aec` |
| Web restarted | no |
| Postgres restarted | no |
| seed executed | no |
| production migrate deploy executed | no |
| `db push` / `migrate reset` executed | no |

### 15.3 API Health

| Check | Result |
| --- | --- |
| deployed container image | `ghcr.io/keqi119/subscription-api:fadada-pr123-envb-20260628-e4bf959` |
| deployed container image id | `sha256:60ab5d638d13f4cf1cb35485093917feb8dbac1856478feea18ae6ef14cd682f` |
| container status | running |
| container health | healthy |
| public `/api/health` | HTTP 200, `status:"ok"`, `storage:"oss"` |

### 15.4 Masked Fadada Runtime Env

Container env re-check passed:

```text
ESIGN_PROVIDER=fadada
FADADA_ENV=production
FADADA_BASE_URL=present_host_ok
FADADA_API_VERSION=2.0
FADADA_ENABLED=true
FADADA_APP_ID=present
FADADA_APP_SECRET=present
FADADA_SIGN_NOTIFY_URL=present
FADADA_SIGN_RETURN_URL=present
FADADA_FULL_SIGNING_SMOKE=1
FADADA_TEST_LOCAL_CUSTOMER_ID=present
FADADA_TEST_CUSTOMER_ID=present
FADADA_AUTO_SIGN_ENABLED=false
FADADA_UPLOAD_SIGNURL_SMOKE=0
FADADA_TEST_SIGNER_REALNAME_PREP=0
```

No app secret, full customer id, full local customer id, phone number, or PII was printed.

### 15.5 Invalid Digest Callback Probe

Probe:

```text
POST https://api.subauto.keybox.cloud/api/esign/callback/fadada
transaction_id=probe
contract_id=probe
result_code=3000
timestamp=20260101000000
msg_digest=invalid
```

Result:

| Field | Result |
| --- | --- |
| HTTP status | 201 |
| body summary | `{"handled":false,"reason":"UNVERIFIED"}` |
| endpoint exists | yes |
| 404 / 500 | no |
| business advancement | no |
| ContractESignTask count after probe | 0 |

This confirms the deployed candidate includes the H1 invalid-digest hardening behavior.

### 15.6 Target Customer Mapping

Read-only production DB mapping check passed:

```text
local_customer_count=1
phone_186****0212_customer_count=1
local_and_phone_same_customer=yes
provider_customer_id=present
contract_esign_task_count=0
contract_count=0
subscription_order_count=1
mapping_ok=yes
```

No full local customer id, provider customer id, phone number, customer name, or PII was printed.

### 15.7 Production Migration Status

Read-only status from the deployed candidate image:

```text
54 migrations found in prisma/migrations
Database schema is up to date
```

The first `pnpm exec prisma migrate status` attempt inside the runtime image triggered pnpm dependency status checks and was killed before DB verification. The status check was rerun with the image-bundled Prisma binary directly and succeeded. No migration was executed.

### 15.8 Rollback

Rollback was not needed.

```text
rollback executed: no
rollback image: ghcr.io/keqi119/subscription-api:portal-rc-r6-20260620-4188aec
```

### 15.9 Gate Decision

Stage 10D-B5-B-ENV-B passed.

The following gate conditions are now satisfied:

- PR #123 API candidate is running in production API;
- production DB schema is up to date;
- Fadada runtime env is present and masked checks passed;
- invalid digest callback probe returned non-500 and `UNVERIFIED`;
- target customer mapping is unique and matches the approved test customer;
- `FADADA_AUTO_SIGN_ENABLED=false`;
- no production seed, DB push, migrate reset, Fadada business API call, task creation, sign URL generation/opening, signing, artifact archive, contract/order advancement, payment posting, write-off, or bill mutation was executed.

Next allowed step:

```text
Stage 10D-B5-B execution approval checkpoint
```

Do not start B5-B full signing execution until the user explicitly approves that checkpoint. PR #123 remains Draft.
