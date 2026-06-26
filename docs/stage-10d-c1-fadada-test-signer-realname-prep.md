# Stage 10D-C1 Fadada Test Signer Real-name Prep

> Date: 2026-06-26
> Branch: `feature/stage10-fadada-test-signer-realname-prep`
> Scope: controlled production-host test signer registration, real-name URL preparation, and optional real-name status query.

## 1. Goal

Stage 10D-C1 prepares a controlled personal test signer for later Fadada production-host upload/signUrl smoke.

This stage only allows:

- `account_register.api`
- `get_person_verify_url.api`
- `find_personCertInfo.api` in status mode, using `verified_serialno`

It does not upload a contract, call `uploaddocs.api`, call `extsign_validation.api`, generate a signing URL, open a real-name URL, complete real-name verification, sign, auto-seal, download signed PDFs, archive artifacts, write the database, advance Contract/Order state, or touch payment, billing, write-off, ROE, BaaS, or depreciation logic.

## 2. Why This Stage Exists

The reused car-rental production channel has been confirmed for Auto Subscription:

- production host: `https://textapi.fadada.com/api2/`
- contract API permissions are open and reusable
- Auto Subscription `notify_url` / `return_url` domains are allowed
- API egress IP whitelist is configured
- current enterprise `customer_id` and `signature_id` are the Auto Subscription seal subject and seal
- production test contract upload is allowed, but billable and visible in Fadada production back office

There is no already-real-named `FADADA_TEST_CUSTOMER_ID`, so the safe next step is to register and prepare a controlled personal signer before any upload/signUrl smoke.

## 3. Local Env

Default local env file:

```text
.env.fadada.production.local
```

The file must be ignored by Git. The script reports only present/missing/masked status.

Required values for real calls:

```env
ESIGN_PROVIDER=fadada
FADADA_ENV=production
FADADA_BASE_URL=https://textapi.fadada.com/api2/
FADADA_APP_ID=
FADADA_APP_SECRET=
FADADA_API_VERSION=2.0
FADADA_ENABLED=true
FADADA_PRODUCTION_SMOKE=1
FADADA_TEST_SIGNER_REALNAME_PREP=1

FADADA_TEST_PERSON_OPEN_ID=subauto-production-smoke-person-001
FADADA_TEST_PERSON_NAME=
FADADA_TEST_PERSON_ID_CARD_NO=
FADADA_TEST_PERSON_MOBILE=

FADADA_VERIFY_NOTIFY_URL=https://api.subauto.keybox.cloud/api/esign/verify-callback/fadada
FADADA_VERIFY_RETURN_URL=https://app.subauto.keybox.cloud/portal/contracts
```

Optional status-mode fallback:

```env
FADADA_TEST_PERSON_VERIFY_SERIALNO=
FADADA_TEST_CUSTOMER_ID=
```

## 4. Safety Gates

Real production-host calls require all gates:

```text
FADADA_ENV=production
FADADA_BASE_URL=https://textapi.fadada.com/api2/
FADADA_ENABLED=true
FADADA_PRODUCTION_SMOKE=1
FADADA_TEST_SIGNER_REALNAME_PREP=1
```

If any gate is missing, the script allows preflight only and refuses prepare/status network calls.

## 5. Script Modes

Commands:

```powershell
pnpm fadada:test-signer:preflight
pnpm fadada:test-signer:prepare
pnpm fadada:test-signer:status
```

Implementation:

```text
scripts/fadada-production-test-signer-realname.mjs
```

### mode=preflight

Only reads env and checks:

- env file present/ignored/not tracked
- production host
- safety gates
- required person fields
- HTTPS verify callback/return URLs

No Fadada request is sent.

### mode=prepare

When gates pass, performs:

1. `account_register.api` with `account_type=1` and `open_id`
2. `get_person_verify_url.api` with controlled test-person real-name fields
3. Base64 URL decoding
4. local output under `.tmp/fadada/test-signer-realname/latest.json`

The output file may contain the full `customer_id`, `transactionNo`, and `verifyUrl`; it is local-only and must not be committed. Console output remains masked.

### mode=status

Reads `transactionNo` from:

1. `.tmp/fadada/test-signer-realname/latest.json`, or
2. `FADADA_TEST_PERSON_VERIFY_SERIALNO`

Then calls `find_personCertInfo.api` with `verified_serialno`.

The PDF documentation confirms `find_personCertInfo.api` uses `verified_serialno`, not `customer_id`, as the query parameter.

## 6. API Client Additions

The Nest Fadada API client now has mock-transport-covered methods:

- `registerAccount({ openId, accountType: "PERSONAL" })`
- `getPersonVerifyUrl({ customerId, name, idCardNo, mobile, notifyUrl, returnUrl, certFlag })`
- `findPersonCertInfo({ verifiedSerialNo })`

All use `application/x-www-form-urlencoded;charset=UTF-8` and endpoint-specific digest rules from the official PDFs.

## 7. PII Handling

Do not commit or paste:

- full `app_secret`
- full name
- full ID card number
- full mobile number
- full `customer_id`
- full `transactionNo`
- full `verifyUrl`
- raw provider response containing sensitive data

The script masks console/report output and writes full values only to `.tmp/fadada/test-signer-realname/latest.json`.

## 8. Current Run Status

Current preflight result: blocked.

Reason: `.env.fadada.production.local` was not present in this local workspace when this stage was implemented.

Real production calls executed in this commit:

- `account_register.api`: no
- `get_person_verify_url.api`: no
- `find_personCertInfo.api`: no

## 9. Next Stage Gate

After `prepare` succeeds:

1. user opens the local `.tmp` real-name URL manually;
2. controlled test signer completes real-name verification;
3. `pnpm fadada:test-signer:status` confirms verified status;
4. copy the personal provider `customer_id` into `FADADA_TEST_CUSTOMER_ID`;
5. enter Stage 10D-B2-C-R1 production-host upload/signUrl controlled smoke.

Do not enter full B5 signing validation until upload/signUrl smoke, callback reachability, signed PDF archive readiness, enterprise seal strategy, and test signer real-name status are all confirmed.

## 10. C1-B Smoke Update

Stage 10D-C1-B is recorded in `docs/stage-10d-c1-fadada-test-signer-realname-smoke.md`.

Result: preflight-only blocked.

Reason: `.env.fadada.production.local` was not present in the local workspace during the C1-B smoke run. The file is covered by `.gitignore:10:.env.*`, but because it was missing no production smoke fields could be confirmed.

Real Fadada calls executed in C1-B:

- `account_register.api`: no
- `get_person_verify_url.api`: no
- `find_personCertInfo.api`: no

No real-name URL was generated, no `.tmp/fadada/test-signer-realname/latest.json` output was written, no contract API was called, and no business database was written.
