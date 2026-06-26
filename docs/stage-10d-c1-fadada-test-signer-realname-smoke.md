# Stage 10D-C1-B Fadada Test Signer Real-name Smoke

> Date: 2026-06-26
> Branch: `feature/stage10-fadada-test-signer-realname-smoke`
> Scope: production-host test signer `account_register.api` and `get_person_verify_url.api` controlled smoke.

## 1. Goal

Stage 10D-C1-B is intended to execute a guarded production-host smoke for a controlled personal test signer:

1. run preflight against `.env.fadada.production.local`;
2. call `account_register.api` only when all production smoke gates pass;
3. call `get_person_verify_url.api` only after a provider customer id is available;
4. write the full provider `customer_id` and real-name URL only to `.tmp/fadada/test-signer-realname/latest.json`;
5. keep console and documentation output masked.

This stage does not upload a contract, create a contract signing URL, sign, auto-seal, download, archive, write the business database, or advance Contract/Order state.

## 2. Env Ignore Check

Local env file:

```text
.env.fadada.production.local
```

Result:

| Check | Result |
| --- | --- |
| File exists | missing |
| Git ignore rule | present via `.gitignore:10:.env.*` |
| Git tracked | no evidence of tracking |
| Env contents printed | no |

Because the env file is missing, no real Fadada request was eligible.

## 3. Preflight Result

Command:

```powershell
pnpm fadada:test-signer:preflight
```

Result: **blocked**.

Script summary:

| Item | Result |
| --- | --- |
| mode | preflight |
| preflight | blocked |
| `account_register.api` | skipped |
| `get_person_verify_url.api` | skipped |
| status query | skipped |
| verify URL | missing |

Blockers:

| Blocker | Status |
| --- | --- |
| `.env.fadada.production.local` | missing |
| `FADADA_ENV=production` | missing |
| `FADADA_ENABLED=true` | missing |
| `FADADA_PRODUCTION_SMOKE=1` | missing |
| `FADADA_TEST_SIGNER_REALNAME_PREP=1` | missing |
| `FADADA_BASE_URL` | missing |
| `FADADA_APP_ID` | missing |
| `FADADA_APP_SECRET` | missing |

No env raw content, app secret, real-name field, provider id, or provider response was printed.

## 4. Safety Gate Result

Required gates for real calls:

```text
FADADA_ENV=production
FADADA_BASE_URL=https://textapi.fadada.com/api2/
FADADA_ENABLED=true
FADADA_PRODUCTION_SMOKE=1
FADADA_TEST_SIGNER_REALNAME_PREP=1
FADADA_APP_ID present
FADADA_APP_SECRET present
FADADA_TEST_PERSON_OPEN_ID present
FADADA_TEST_PERSON_NAME present
FADADA_TEST_PERSON_ID_CARD_NO present
FADADA_TEST_PERSON_MOBILE present
FADADA_VERIFY_NOTIFY_URL https
FADADA_VERIFY_RETURN_URL https
```

Gate decision: **not passed**.

Reason: the local production env file was not present in this workspace, so no required production smoke fields could be confirmed.

## 5. Account Register Result

`account_register.api` executed: **no**.

Provider `customer_id`:

| Field | Result |
| --- | --- |
| obtained | no |
| masked output | not applicable |
| stored in `.tmp` | no |

No provider account was registered in this run.

## 6. Real-name URL Result

`get_person_verify_url.api` executed: **no**.

Real-name URL:

| Field | Result |
| --- | --- |
| generated | no |
| printed | no |
| opened automatically | no |
| written to `.tmp/fadada/test-signer-realname/latest.json` | no |

## 7. Status Query

`pnpm fadada:test-signer:status` executed: **no**.

Reason: this stage stops after `prepare`; status should run only after the user manually opens the local `.tmp` real-name URL and completes real-name verification.

## 8. Quality Gate

The branch baseline was verified after syncing local `main` to the merged Stage 10D-C1 commit.

Database-backed checks used an isolated local PostgreSQL container:

```text
subauto-prisma-check-postgres
127.0.0.1:55432/subscription_saas
```

No remote or production database seed was executed.

Results:

| Command | Result |
| --- | --- |
| `pnpm release:check` | passed |
| `pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma` | passed |

`release:check` also covered lint, API/Web typecheck, API tests, Fadada sandbox smoke tests, and Fadada test signer real-name prep syntax.

## 9. Boundary Confirmation

This run did not:

- call any Fadada API;
- call `uploaddocs.api`;
- call `extsign_validation.api`;
- call `extsign_auto.api`;
- call `downLoadContract.api`;
- call `contractFiling.api`;
- generate a signing URL;
- open a real-name URL;
- upload a contract;
- sign or auto-seal;
- write the business database;
- advance Contract or Order state;
- touch payment, billing, write-off, ROE, BaaS, or depreciation logic;
- commit `.env.fadada.production.local`;
- commit `.tmp`;
- commit name, ID card number, mobile, full `customer_id`, full verify URL, app secret, or raw provider response.

## 10. Gate Decision

`FADADA_TEST_CUSTOMER_ID` ready: **no**.

Stage 10D-B2-C-R1 can start: **no**.

Required next action:

1. restore or create `.env.fadada.production.local` with the guarded production-host values;
2. rerun `pnpm fadada:test-signer:preflight`;
3. only if preflight passes, run `pnpm fadada:test-signer:prepare`;
4. manually open the local `.tmp` real-name URL and complete verification;
5. run `pnpm fadada:test-signer:status`;
6. after verified, put the provider customer id into `FADADA_TEST_CUSTOMER_ID`;
7. then enter Stage 10D-B2-C-R1 production-host upload/signUrl controlled smoke.

## 11. C1-B-R1 Rerun Update

Date: 2026-06-26

The local `.env.fadada.production.local` file was restored before this rerun.

Env safety check:

| Check | Result |
| --- | --- |
| File exists | present |
| Git ignore rule | present via `.gitignore:10:.env.*` |
| Git tracked | no evidence of tracking |
| Env raw content printed | no |

Preflight command:

```powershell
pnpm fadada:test-signer:preflight
```

Preflight result: **passed**.

Prepare command:

```powershell
pnpm fadada:test-signer:prepare
```

Prepare result: **failed**.

Script summary:

| Item | Result |
| --- | --- |
| preflight | passed |
| `account_register.api` | executed, failed |
| provider `customer_id` | not obtained |
| `get_person_verify_url.api` | skipped |
| verify URL | not generated |
| `.tmp/fadada/test-signer-realname/latest.json` | not written |
| status query | not executed |

Blocker:

```text
account_register.api did not return a customer_id
```

The script output did not expose a full provider response or a provider error code. No app secret, real-name field, full customer id, verify URL, or raw response was printed or written to documentation.

Boundary confirmation for R1:

- No contract upload was executed.
- No signing URL was generated.
- No real-name URL was opened.
- No contract/order state was advanced.
- No business database was written.
- `.env.fadada.production.local` remained ignored and untracked.
- `.tmp` was not committed.

R1 gate decision:

| Gate | Result |
| --- | --- |
| `FADADA_TEST_CUSTOMER_ID` ready | no |
| Stage 10D-B2-C-R1 can start | no |

Recommended next action: inspect Fadada back-office/provider-side response for the attempted `account_register.api` call, or run a follow-up diagnostic that safely records the provider error code and sanitized response. Do not enter upload/signUrl smoke until a provider customer id is obtained and the signer real-name flow is ready.

## 12. C1-B-R2 Rerun Update

Date: 2026-06-26

This rerun was executed after the Fadada IP whitelist was updated for the previously blocked outbound IP.

Env safety check:

| Check | Result |
| --- | --- |
| File exists | present |
| Git ignore rule | present via `.gitignore:10:.env.*` |
| Git tracked | no evidence of tracking |
| Env raw content printed | no |

Preflight command:

```powershell
pnpm fadada:test-signer:preflight
```

Preflight result: **passed**.

Prepare command:

```powershell
pnpm fadada:test-signer:prepare
```

Prepare result: **passed**.

Script summary:

| Item | Result |
| --- | --- |
| preflight | passed |
| `account_register.api` | executed, success |
| provider `customer_id` | obtained, masked only |
| `get_person_verify_url.api` | executed, success |
| verify URL | generated, not printed |
| `.tmp/fadada/test-signer-realname/latest.json` | written, ignored |
| status query | not executed |

Local output check:

| Field | Result |
| --- | --- |
| `customer_id` in `.tmp` | present |
| verify URL in `.tmp` | present |
| real-name transaction field in `.tmp` | present |
| `.tmp` committed | no |

Boundary confirmation for R2:

- No contract upload was executed.
- No signing URL was generated.
- No real-name URL was opened automatically.
- No status query was executed.
- No contract/order state was advanced.
- No business database was written.
- No payment, billing, write-off, ROE, BaaS, or depreciation logic was touched.
- `.env.fadada.production.local` remained ignored and untracked.
- `.tmp` remained ignored and untracked.
- No app secret, real-name field, full customer id, verify URL, or raw provider response was committed or written to documentation.

R2 gate decision:

| Gate | Result |
| --- | --- |
| Provider customer id obtained | yes |
| Real-name URL generated | yes |
| User manual real-name completed | pending |
| `pnpm fadada:test-signer:status` verified | no |
| `FADADA_TEST_CUSTOMER_ID` ready for upload/signUrl smoke | not yet |
| Stage 10D-B2-C-R1 can start | no |

R2 quality gate:

| Command | Result |
| --- | --- |
| `pnpm release:check` | passed |

Database-backed release checks used the isolated local PostgreSQL container at `127.0.0.1:55432/subscription_saas`. No remote or production database seed was executed.

Required next action:

1. The user manually opens the verify URL stored in `.tmp/fadada/test-signer-realname/latest.json`.
2. The user completes personal real-name verification.
3. Run `pnpm fadada:test-signer:status`.
4. If status confirms verified, copy the provider customer id into `FADADA_TEST_CUSTOMER_ID`.
5. Then enter Stage 10D-B2-C-R1 production-host upload/signUrl controlled smoke.

