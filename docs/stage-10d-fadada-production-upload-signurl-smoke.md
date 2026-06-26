# Stage 10D-B2-C-R1 Fadada Production Upload/SignUrl Smoke

> Date: 2026-06-26
> Branch: `feature/stage10-fadada-production-upload-signurl-smoke`
> Scope: production-host `uploaddocs.api` + `extsign_validation.api` controlled smoke.

## 1. Goal

Stage 10D-B2-C-R1 prepares and, only when all local safety gates are enabled, runs a production-host upload/signUrl smoke against the confirmed reused Fadada host:

```text
https://textapi.fadada.com/api2/
```

The stage is limited to a non-sensitive test PDF upload and one customer signing URL creation. It must not open the sign URL, sign, auto-seal, download, archive, write the business database, advance Contract/Order state, or touch payment/billing/write-off logic.

## 2. Script

New guarded script:

```text
scripts/fadada-production-upload-signurl-smoke.mjs
```

Commands:

```powershell
pnpm fadada:upload-signurl:preflight
pnpm fadada:upload-signurl:run
pnpm fadada:upload-signurl:test
```

`release:check` only runs syntax and unit tests. It does not run the real production-host smoke.

## 3. Env Ignore Check

Local env file:

```text
.env.fadada.production.local
```

Result:

| Check | Result |
| --- | --- |
| File exists | present |
| Git ignore rule | present via `.gitignore:10:.env.*` |
| Git tracked | no evidence of tracking |
| Env raw content printed | no |

## 4. Env Preflight Result

Command:

```powershell
pnpm fadada:upload-signurl:preflight
```

Result: **blocked**.

Script summary:

| Item | Result |
| --- | --- |
| mode | preflight |
| preflight | blocked |
| `uploaddocs.api` | skipped |
| `extsign_validation.api` | skipped |
| signUrl | missing |

Blocker:

```text
FADADA_UPLOAD_SIGNURL_SMOKE=1 is required
```

The script refused to make any real Fadada call because the dedicated upload/signUrl smoke safety switch was not enabled.

## 5. Safety Gate Result

Required gates for real calls:

```text
FADADA_ENV=production
FADADA_BASE_URL=https://textapi.fadada.com/api2/
FADADA_ENABLED=true
FADADA_PRODUCTION_SMOKE=1
FADADA_UPLOAD_SIGNURL_SMOKE=1
FADADA_APP_ID present
FADADA_APP_SECRET present
FADADA_TEST_CUSTOMER_ID present
FADADA_SIGN_NOTIFY_URL https
FADADA_SIGN_RETURN_URL https
```

Gate decision: **not passed**.

## 6. Test PDF Result

The script can generate a local non-sensitive PDF fixture at:

```text
.tmp/fadada/upload-signurl-smoke/test-contract.pdf
```

The current run was preflight-only, so no PDF was uploaded to Fadada.

Fixture properties covered by tests:

| Check | Result |
| --- | --- |
| PDF magic bytes | covered |
| `<=20MB` | covered |
| Marked as test contract | covered |
| No real name / ID card / mobile / VIN / plate | covered |
| Git committed | no |

## 7. uploadDocs Result

`uploaddocs.api` executed: **no**.

Reason: preflight blocker.

## 8. extsign_validation Result

`extsign_validation.api` executed: **no**.

Reason: preflight blocker.

## 9. signUrl Result

| Field | Result |
| --- | --- |
| signUrl obtained | no |
| signUrl opened | no |
| signUrl printed | no |
| `.tmp/fadada/upload-signurl-smoke/latest.json` written | no |

## 10. Test Coverage

New test file:

```text
scripts/fadada-production-upload-signurl-smoke.test.mjs
```

Coverage:

- missing env blocks run;
- `FADADA_UPLOAD_SIGNURL_SMOKE != 1` blocks run;
- non-production base URL blocks production run;
- missing `FADADA_TEST_CUSTOMER_ID` blocks run;
- customer id and sign URL masking;
- uploadDocs request builder;
- extsign_validation request builder;
- non-sensitive PDF fixture generation;
- mock transport upload/signUrl flow;
- the script never opens signUrl.

## 11. Boundary Confirmation

This run did not:

- call Fadada production business endpoints;
- call `uploaddocs.api`;
- call `extsign_validation.api`;
- call `extsign_auto.api`;
- open a sign URL;
- complete signing;
- auto-seal;
- download signed PDF;
- call `contractFiling.api`;
- write the business database;
- advance Contract or Order state;
- touch payment, billing, write-off, ROE, BaaS, or depreciation logic;
- add a Prisma schema change or migration;
- commit `.env.fadada.production.local`;
- commit `.tmp`;
- commit app secret, full customer id, full signature id, full sign URL, or provider raw response.

## 12. Gate Decision

Stage 10D-B2-C-R1 gate passed: **no**.

Reason: the dedicated real-call switch `FADADA_UPLOAD_SIGNURL_SMOKE=1` is not enabled in the ignored local env file.

Stage 10D-B5 can start: **no**.

Next action:

1. Set `FADADA_UPLOAD_SIGNURL_SMOKE=1` in `.env.fadada.production.local` only when intentionally ready to make the production-host test upload/signUrl call.
2. Rerun `pnpm fadada:upload-signurl:preflight`.
3. If preflight passes, run `pnpm fadada:upload-signurl:run`.
4. Do not open the resulting sign URL until Stage 10D-B5-A explicitly confirms the full signing plan.

## 13. RUN After Enabling Upload/SignUrl Gate

Date: 2026-06-26

The user enabled the dedicated real-call gate in the ignored local env file:

```text
FADADA_UPLOAD_SIGNURL_SMOKE=1
```

Env safety check:

| Check | Result |
| --- | --- |
| `.env.fadada.production.local` exists | present |
| Git ignore rule | present via `.gitignore:10:.env.*` |
| Git tracked | no evidence of tracking |
| Env raw content printed | no |

Preflight command:

```powershell
pnpm fadada:upload-signurl:preflight
```

Preflight result: **passed**.

Run command:

```powershell
pnpm fadada:upload-signurl:run
```

Run result: **failed**.

Script summary:

| Item | Result |
| --- | --- |
| preflight | passed |
| `uploaddocs.api` | executed, failed |
| `extsign_validation.api` | skipped |
| signUrl | missing |
| blocker | `uploaddocs.api failed` |

Local output:

| Item | Result |
| --- | --- |
| test PDF | present |
| test PDF size | 638 bytes |
| `.tmp/fadada/upload-signurl-smoke/latest.json` | not written |
| full signUrl | not present |

Provider diagnostics:

| Field | Result |
| --- | --- |
| provider error code | not captured by the current CLI summary |
| sanitized provider response | not captured by the current CLI summary |

The current script stopped correctly after `uploaddocs.api` failed and did not call `extsign_validation.api`.

Boundary confirmation for this RUN:

- A real production-host `uploaddocs.api` request was attempted.
- No `extsign_validation.api` request was sent.
- No sign URL was generated.
- No sign URL was opened.
- No signing was completed.
- No platform auto-seal was executed.
- No signed PDF was downloaded.
- No artifact archive was executed.
- No business database was written.
- No Contract or Order state was advanced.
- No payment, billing, write-off, ROE, BaaS, or depreciation logic was touched.
- `.env.fadada.production.local` remained ignored and untracked.
- `.tmp` remained ignored and untracked.
- No app secret, full customer id, full signature id, full signUrl, or provider raw response was committed.

RUN gate decision:

| Gate | Result |
| --- | --- |
| uploadDocs production-host smoke | failed |
| extsign_validation production-host smoke | not executed |
| signUrl obtained | no |
| Stage 10D-B5 can start | no |

Recommended next action:

1. Do not retry blindly, because the host may create provider-side records or costs.
2. Check the Fadada provider console or ask Fadada support for the failed `uploaddocs.api` request reason around this run time.
3. If another retry is needed, first add/confirm a diagnostic path that safely captures provider error code and sanitized response without committing raw provider payloads.
