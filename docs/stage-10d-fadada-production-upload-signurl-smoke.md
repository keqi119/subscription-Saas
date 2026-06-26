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
pnpm fadada:upload-signurl:signurl-only
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

## 14. Diagnostic Request Logging Enhancement

Date: 2026-06-26

After the first RUN failed at `uploaddocs.api`, the smoke script was enhanced so future RUN attempts write explicit request diagnostics to the ignored local file:

```text
.tmp/fadada/upload-signurl-smoke/latest.json
```

This local file must not be committed. It is intended for controlled provider-side troubleshooting with Fadada support.

### 14.1 uploaddocs.api Diagnostic Fields

Future RUN attempts record the following explicit upload request fields:

```json
{
  "requests": {
    "uploadDocs": {
      "endpoint": "uploaddocs.api",
      "method": "POST",
      "url": "https://textapi.fadada.com/api2/uploaddocs.api",
      "contentType": "multipart/form-data;charset=utf8",
      "params": {
        "contract_id": "<generated smoke contract id>",
        "doc_title": "SubAuto Fadada Production Host Smoke Test",
        "doc_type": ".pdf",
        "app_id": "<configured app_id>",
        "timestamp": "<yyyyMMddHHmmss>",
        "v": "2.0",
        "msg_digest": "<calculated digest>"
      },
      "file": {
        "fieldName": "file",
        "fileName": "subauto-fadada-production-host-smoke.pdf",
        "contentType": "application/pdf",
        "sizeBytes": 638,
        "sha256": "<test PDF sha256>"
      }
    }
  },
  "provider": {
    "uploadDocs": {
      "httpStatus": "<HTTP status>",
      "code": "<provider code if returned>",
      "msg": "<provider msg if returned>"
    }
  }
}
```

The diagnostic file does not include `app_secret` or the PDF binary content.

### 14.2 extsign_validation.api Diagnostic Fields

Only if `uploaddocs.api` succeeds, future RUN attempts also record:

```json
{
  "requests": {
    "extSignValidation": {
      "endpoint": "extsign_validation.api",
      "method": "POST",
      "url": "https://textapi.fadada.com/api2/extsign_validation.api",
      "contentType": "application/x-www-form-urlencoded;charset=UTF-8",
      "params": {
        "contract_id": "<same smoke contract id>",
        "customer_id": "<configured test signer customer_id>",
        "notify_url": "<configured sign notify URL>",
        "quantity": "<configured or default quantity>",
        "return_url": "<configured sign return URL>",
        "transaction_id": "<generated smoke transaction id>",
        "validity": "<configured or default validity>",
        "app_id": "<configured app_id>",
        "timestamp": "<yyyyMMddHHmmss>",
        "v": "2.0",
        "msg_digest": "<calculated digest>"
      }
    }
  },
  "provider": {
    "extSignValidation": {
      "httpStatus": "<HTTP status>",
      "code": "<provider code if returned>",
      "msg": "<provider msg if returned>"
    }
  },
  "signUrl": "<only present when provider returns a sign URL>"
}
```

The committed documentation must continue to use masked/present status only. Full request values are local-only under `.tmp`.

This enhancement does not retry the real provider call by itself. A new RUN is required to generate the diagnostic file for the next provider-side investigation.

## 15. R2 Diagnostic RUN Result

Date: 2026-06-26

After diagnostics were added, one controlled R2 RUN was executed to collect provider-side troubleshooting evidence.

### 15.1 Safety Check

| Check | Result |
| --- | --- |
| `.env.fadada.production.local` exists | present |
| `.env.fadada.production.local` ignored | yes |
| `.tmp/fadada/upload-signurl-smoke/latest.json` ignored | yes |
| Git status exposed env/tmp | no |

### 15.2 Preflight

Command:

```powershell
pnpm fadada:upload-signurl:preflight
```

Result: **passed**.

### 15.3 RUN

Command:

```powershell
pnpm fadada:upload-signurl:run
```

Result: **failed**.

Script summary:

| Item | Result |
| --- | --- |
| preflight | passed |
| `uploaddocs.api` | executed, failed |
| `extsign_validation.api` | skipped |
| signUrl | missing |
| `.tmp/fadada/upload-signurl-smoke/latest.json` | written |

### 15.4 Sanitized uploadDocs Diagnostics

The following fields were extracted from the ignored local diagnostic file. Full sensitive values are not committed.

| Field | Value |
| --- | --- |
| endpoint | `uploaddocs.api` |
| method | `POST` |
| host | `textapi.fadada.com` |
| content type | `multipart/form-data;charset=utf8` |
| `contract_id` | masked, present |
| `contract_id` length | `42` |
| `doc_title` | `SubAuto Fadada Production Host Smoke Test` |
| `doc_type` | `.pdf` |
| `app_id` | present, masked |
| `timestamp` | `20260626203516` |
| `v` | `2.0` |
| `msg_digest` | present |
| file field name | `file` |
| file name | `subauto-fadada-production-host-smoke.pdf` |
| file content type | `application/pdf` |
| file size | `638 bytes` |
| file SHA-256 | `f14dc92193f2ee9a560001a9c265ea7069949241478b62a3b80a428756f8e9cc` |
| HTTP status | `200` |
| provider code | `2002` |
| provider msg | captured as mojibake; inferred as `无效合同编号.(合同编号不能为空且字符长度不超过40)` |

The provider message inference is based on the captured mojibake text and common UTF-8/GBK display mismatch. The actionable meaning is clear enough to diagnose the current blocker: the generated smoke `contract_id` length was `42`, while the provider message says the contract number length must not exceed `40`.

### 15.5 Boundary Confirmation

- One real production-host `uploaddocs.api` request was attempted.
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
- No app secret, full customer id, full signature id, full signUrl, PDF binary, or provider raw response was committed.

### 15.6 Gate Decision

| Gate | Result |
| --- | --- |
| uploadDocs production-host smoke | failed |
| extsign_validation production-host smoke | not executed |
| signUrl obtained | no |
| Stage 10D-B5 can start | no |

Current likely blocker:

```text
Generated smoke contract_id is too long for uploaddocs.api.
```

This R2 blocker is addressed by the R3 preparation fix below. A real R3 retry still requires explicit user authorization.

## 16. R3 Contract ID Length Fix

### 16.1 R2 Blocker

R2 captured the provider-side blocker:

```text
provider code: 2002
provider msg: invalid contract number; contract number must be non-empty and no longer than 40 characters
generated smoke contract_id length: 42
```

### 16.2 Fix Applied

The smoke identifier generation was shortened before any further real provider retry:

| Identifier | New format | Length |
| --- | --- | --- |
| `contract_id` | `SAESyyyyMMddHHmmssXXXXXX` | `24` |
| `transaction_id` | `SATXyyyyMMddHHmmssXXXXXX` | `24` |

Where:

- `yyyyMMddHHmmss` is the Fadada timestamp format.
- `XXXXXX` is a random uppercase alphanumeric suffix.
- IDs contain only `A-Z0-9`.
- IDs do not include customer data, phone numbers, VINs, license plates, or business contract numbers.

### 16.3 Verification

Added unit coverage confirms:

- generated `contract_id` is non-empty;
- generated `contract_id` length is `<= 40`;
- generated `contract_id` uses only safe uppercase alphanumeric characters;
- generated `transaction_id` length is `<= 40`;
- generated `transaction_id` uses only safe uppercase alphanumeric characters;
- diagnostic `latest.json` records the shortened generated IDs.

Verification commands executed after the fix:

```text
node --check scripts/fadada-production-upload-signurl-smoke.mjs
pnpm fadada:upload-signurl:preflight
pnpm fadada:upload-signurl:test
pnpm release:check
```

`pnpm release:check` passed against isolated local PostgreSQL at `127.0.0.1:55432`; no remote or production database was seeded.

### 16.4 R3 Run Status

No real R3 provider call has been executed as part of this fix. A real production-host R3 run still requires explicit user authorization because it may create Fadada backend records and may incur cost.

## 17. R3 Controlled Run Result

### 17.1 Execution

R3 was executed once after the smoke `contract_id` length fix.

```text
env ignore check: passed
preflight: passed
real provider run: executed once
uploaddocs.api: called
extsign_validation.api: skipped
signUrl: not obtained
```

### 17.2 Sanitized uploadDocs Request

| Field | Value |
| --- | --- |
| endpoint | `uploaddocs.api` |
| method | `POST` |
| host | `textapi.fadada.com` |
| content type | `multipart/form-data;charset=utf8` |
| `contract_id` | masked, present |
| `contract_id` length | `24` |
| `contract_id` character set | `A-Z0-9 only` |
| `doc_title` | `SubAuto Fadada Production Host Smoke Test` |
| `doc_type` | `.pdf` |
| `app_id` | present, masked |
| `timestamp` | `20260626212546` |
| `v` | `2.0` |
| `msg_digest` | present |
| file field name | `file` |
| file name | `subauto-fadada-production-host-smoke.pdf` |
| file content type | `application/pdf` |
| file size | `638 bytes` |
| file SHA-256 | `f14dc92193f2ee9a560001a9c265ea7069949241478b62a3b80a428756f8e9cc` |

### 17.3 Provider Response

| Field | Value |
| --- | --- |
| HTTP status | `200` |
| provider code | `1000` |
| provider msg | `operation success` |

### 17.4 Local Script Result

The provider response indicates `uploaddocs.api` likely succeeded, but the local smoke script still classified the upload step as failed because its success-code helper did not treat provider code `1000` as success.

```text
local uploadDocs status: failed
local blocker: uploaddocs.api failed
extsign_validation executed: no
signUrl obtained: no
```

### 17.5 Boundary Confirmation

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
- No app secret, full customer id, full signature id, full signUrl, PDF binary, or provider raw response was committed.

### 17.6 Next Blocker

Before another real provider retry, update the local smoke success-code mapping to treat the confirmed Fadada success code `1000` as success for `uploaddocs.api`, add unit coverage, and then request explicit approval for a follow-up controlled run.

## 18. Upload Success Code Normalization Fix

### 18.1 Root Cause

R3 showed that Fadada returned:

```text
HTTP status: 200
provider code: 1000
provider msg: operation success
```

The local production upload/signUrl smoke script still classified the upload as failed because its success-code helper only accepted legacy values and did not accept Fadada code `1000`.

### 18.2 Fix

The local smoke success-code mapping now treats Fadada provider code `1000` as success.

```text
code=1000 => success
code=2002 => failed
```

### 18.3 Test Coverage

Updated unit coverage confirms:

- `uploaddocs.api` response `code=1000` is treated as success;
- after upload success, the script proceeds to the mocked `extsign_validation.api` path;
- `extsign_validation.api` response `code=1000` with a URL is treated as success;
- `uploaddocs.api` response `code=2002` remains failed;
- no sign URL is opened in tests.

No real Fadada call was executed for this fix.

## 19. R4 Controlled Run Result

### 19.1 Execution

R4 was executed once after the Fadada success-code normalization fix.

```text
env ignore check: passed
preflight: passed
real provider run: executed once
uploaddocs.api: called
uploaddocs.api result: success
extsign_validation.api: called
extsign_validation.api result: failed
signUrl: not obtained
```

### 19.2 Sanitized uploadDocs Request and Result

| Field | Value |
| --- | --- |
| endpoint | `uploaddocs.api` |
| method | `POST` |
| host | `textapi.fadada.com` |
| content type | `multipart/form-data;charset=utf8` |
| `contract_id` | masked, present |
| `contract_id` length | `24` |
| `doc_title` | `SubAuto Fadada Production Host Smoke Test` |
| `doc_type` | `.pdf` |
| `timestamp` | `20260626221158` |
| `v` | `2.0` |
| `msg_digest` | present |
| file field name | `file` |
| file name | `subauto-fadada-production-host-smoke.pdf` |
| file content type | `application/pdf` |
| file size | `638 bytes` |
| file SHA-256 | `f14dc92193f2ee9a560001a9c265ea7069949241478b62a3b80a428756f8e9cc` |
| HTTP status | `200` |
| provider code | `1000` |
| provider msg | `operation success` |

### 19.3 Sanitized extsign_validation Request and Result

| Field | Value |
| --- | --- |
| endpoint | `extsign_validation.api` |
| method | `POST` |
| host | `textapi.fadada.com` |
| content type | `application/x-www-form-urlencoded;charset=UTF-8` |
| `contract_id` | masked, present |
| `contract_id` length | `24` |
| `transaction_id` | masked, present |
| `transaction_id` length | `24` |
| `customer_id` | present, masked |
| `return_url` host | `app.subauto.keybox.cloud` |
| `notify_url` host | `api.subauto.keybox.cloud` |
| `validity` | `30` |
| `quantity` | `1` |
| `timestamp` | `20260626221158` |
| `v` | `2.0` |
| `msg_digest` | present |
| HTTP status | `200` |
| provider code | not parsed |
| provider msg | not parsed |
| signUrl | missing |

### 19.4 Local Script Result

The upload step now passed and the script continued to `extsign_validation.api`. The sign URL step failed because the provider response did not expose a parseable sign URL in the current local diagnostic output.

```text
local uploadDocs status: success
local extSignValidation status: failed
local blocker: extsign_validation.api did not return a signUrl
```

### 19.5 Boundary Confirmation

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
- No app secret, full customer id, full signature id, full signUrl, PDF binary, or provider raw response was committed.

### 19.6 Next Blocker

Before another real provider retry, either:

1. ask Fadada support to inspect the R4 `extsign_validation.api` request by timestamp, masked `contract_id`, and masked `transaction_id`; or
2. enhance local diagnostics to persist a sanitized provider response body shape for `extsign_validation.api`, then request explicit approval for one follow-up controlled run.

Do not enter Stage 10D-B5 until `extsign_validation.api` returns a sign URL and the user separately authorizes full signing validation.

## 20. Local Fadada Document Review and Tooling Fix

### 20.1 Documents Checked

Local Fadada documents reviewed from `D:\Projects\document\fadada\doc`:

| Document | Relevant finding |
| --- | --- |
| `4.2.7 ... extsign_validation ... .pdf` | `extsign_validation.api` is documented as a page interface with request method `GET`. |
| `4.2.7 ... extsign_validation ... .pdf` | SDK sample says the interface returns a link address. |
| `3.7.1 ... manual sign ... .pdf` | The manual sign page points users to `extsign_validation.api` when validity and open-count controls are required. |
| `3.10 ... error code list ... .pdf` | Common code `1` is listed as success, but the production-host R3/R4 evidence showed `1000` as operation success for `uploaddocs.api`. |

### 20.2 Root Cause Update

R4 reached `extsign_validation.api`, but no signUrl was parsed. The local document review explains the likely tooling gap:

```text
extsign_validation.api is a GET page interface.
The response can be the sign URL itself, not a JSON object with code/msg/data.
```

The previous smoke tool still treated `extsign_validation.api` like a form POST API and only parsed JSON-style URL fields.

### 20.3 Tooling Changes

The production upload/signUrl smoke tool was updated without making any real provider call:

- `extsign_validation.api` requests now use `GET`.
- GET requests put signed request parameters in the query string.
- GET requests do not send a request body or content-type header.
- a plain text HTTP URL response is now treated as the signUrl.
- text provider responses now record diagnostic shape fields:
  - `bodyKind`
  - `bodyTextLength`
  - `bodyTextPreview`
  - `contentType`, if present
- URL previews are masked before being written to diagnostics.

### 20.4 Test Coverage

Updated unit coverage confirms:

- `buildExtSignValidationRequest` uses method `GET`;
- `buildTransportRequest` sends `extsign_validation.api` params as query string;
- GET transport request has no body and no content-type header;
- direct URL text response is accepted as signUrl;
- signUrl is still not opened by the smoke tool;
- non-URL text response is captured as sanitized diagnostics.

No real Fadada call was executed for this document-based tooling fix.

### 20.5 Next Step

After this fix is pushed, a follow-up controlled run can verify whether `extsign_validation.api` returns a parseable sign URL. That run still requires explicit user authorization because it calls the production host and may create Fadada backend records or cost.

Do not enter Stage 10D-B5 until uploadDocs and extsign_validation both pass and the user separately authorizes full signing validation.

## 22. R5 signUrl-only Controlled Run

Date: 2026-06-27

R5 used the R3/R4 successfully uploaded test contract and did not call `uploaddocs.api` again.

### 22.1 Tooling Update Before R5

The smoke script now supports:

```powershell
pnpm fadada:upload-signurl:signurl-only
```

This mode:

- reads the ignored `.tmp/fadada/upload-signurl-smoke/latest.json`;
- requires a reusable `contract_id` whose prior upload provider code is `1000`;
- calls only `extsign_validation.api`;
- uses method `GET`;
- sends request parameters in the query string;
- does not send a request body;
- does not send a `content-type` request header;
- writes full local diagnostics only to ignored `.tmp`;
- never opens the sign URL.

### 22.2 R5 Preconditions

| Check | Result |
| --- | --- |
| branch | `feature/stage10-fadada-production-upload-signurl-smoke-run` |
| env file ignored | yes |
| `.tmp` ignored | yes |
| preflight | passed |
| reusable uploaded `contract_id` | yes, masked |
| reusable upload provider code | `1000` |
| reusable upload HTTP status | `200` |
| reusable `contract_id` length | `24` |

### 22.3 R5 Execution Result

Command:

```powershell
pnpm fadada:upload-signurl:signurl-only
```

Result:

| Item | Result |
| --- | --- |
| mode | `signurl-only` |
| reused R3/R4 upload | yes |
| `uploaddocs.api` called in R5 | no |
| `extsign_validation.api` called | yes |
| `extsign_validation.api` method | `GET` |
| request body | absent |
| request `content-type` header | absent |
| query params | present |
| HTTP status | `200` |
| response content type | `text/html;charset=UTF-8` |
| response body kind | `text` |
| response body length | `4383` |
| signUrl obtained | no |
| `.tmp/fadada/upload-signurl-smoke/latest.json` written | yes |

Provider response diagnostic preview was HTML, not a raw `http/https` URL:

```text
<link rel="stylesheet" type="text/css" href="libs/static/css/loading.css?v=20230213"/>
<style>
...
```

The smoke tool therefore did not treat it as a sign URL.

### 22.4 R5 Boundary Confirmation

- No sign URL was opened.
- No signing was completed.
- No platform auto-seal was executed.
- No signed PDF was downloaded.
- No artifact archive was executed.
- No business database was written.
- No Contract or Order state was advanced.
- No payment, billing, write-off, ROE, BaaS, or depreciation logic was touched.
- No app secret, full customer id, full signature id, full signUrl, PDF binary, or provider raw response was committed.

### 22.5 R5 Blocker

`extsign_validation.api` returned an HTML document with HTTP 200 instead of a raw URL text response. The current smoke tool records this as:

```text
extsign_validation.api did not return a signUrl
```

Before Stage 10D-B5-A, confirm with Fadada whether this HTML response should be considered the sign page itself, whether the request URL should be used as the customer signing URL, or whether another response/header/redirect field must be captured.

Stage 10D-B5-A can start: **no**, until the sign URL interpretation is confirmed or the provider returns a parseable sign URL.

## 23. D1 Sign Page Semantic Check

Date: 2026-06-27

Stage 10D-D1 generated an `extsign_validation.api` GET entry URL from the previously uploaded test contract. The full URL was written only to ignored local `.tmp` files and was not committed.

### 23.1 First Manual Observation

The user manually opened the generated entry URL for observation only.

| Item | Result |
| --- | --- |
| reused uploaded `contract_id` | yes |
| generated sign page entry URL | yes |
| URL stored only in `.tmp` | yes |
| user opened URL | yes |
| signing clicked | no |
| SMS / verification code requested | no |
| contract/order advanced | no |
| business database written | no |
| page classification | error |
| page message | `doc_title不能为空` |

### 23.2 Root Cause

The local Fadada PDF document `4.2.7 扩展接口列表_签署_文档签署接口（含有效期和次数）.pdf` confirms:

- `extsign_validation.api` is a `GET` page interface;
- the interface returns a link address;
- `doc_title` is a required request parameter;
- `doc_title` must be UTF-8 URL-encoded;
- the documented digest formula remains based on `transaction_id + timestamp + validity + quantity` and `app_secret + customer_id`.

The previous D1 generated URL did not include `doc_title`, so the provider error was consistent with the official document.

### 23.3 Local Fix

The following local builders now include `doc_title` for `extsign_validation.api`:

- production upload/signUrl smoke builder;
- sandbox upload/signUrl smoke builder;
- `FadadaApiClient.createExternalSignUrl`;
- `FadadaESignProvider.createSignTask` passes `input.documentName` as the Fadada `doc_title`.

The fix does not change the signing semantics yet. It only supplies the required page parameter.

### 23.4 New D1 Entry URL

A new semantic-check URL was generated after the fix:

```text
.tmp/fadada/signpage-semantic/latest.json
```

Sanitized metadata:

| Item | Result |
| --- | --- |
| method | `GET` |
| request body | absent |
| request `content-type` header | absent |
| `doc_title` present | yes |
| `doc_title` | `SubAuto Fadada Production Host Smoke Test` |
| `contract_id` length | `24` |
| `transaction_id` length | `24` |
| validity | `30` |
| quantity | `1` |

The full URL remains local-only in `.tmp`; do not paste it into chat or commit it.

### 23.5 Next Observation

Open the new `.tmp/fadada/signpage-semantic/latest.json` URL manually and classify the page:

```text
A. HTML signing page
B. redirect entry
C. raw URL response
D. asks for another interface
E. error page
```

No signing, SMS code request, submit action, auto-seal, callback advancement, signed PDF download, or archive should be performed.

Stage 10D-B5-A can start: **no**, until the corrected `doc_title` URL is observed and the page semantic is confirmed.

## 24. Chinese Support Handoff

The following text can be sent to Fadada technical support:

```text
法大大 uploaddocs.api 诊断性测试报告

项目：汽车订阅 / SubAuto
接口模式：API URL 直连 HTTPS 请求
环境：https://textapi.fadada.com/api2/
接口：uploaddocs.api
请求方式：POST
Content-Type：multipart/form-data;charset=utf8
调用时间 timestamp：20260626203516

本次只做测试合同上传，不打开 signUrl，不签署，不自动盖章，不推进业务状态。

入参摘要：
- app_id：present / masked
- contract_id：present / masked
- contract_id 长度：42
- doc_title：SubAuto Fadada Production Host Smoke Test
- doc_type：.pdf
- timestamp：20260626203516
- v：2.0
- msg_digest：present
- 文件字段名：file
- 文件名：subauto-fadada-production-host-smoke.pdf
- 文件 Content-Type：application/pdf
- 文件大小：638 bytes
- 文件 SHA-256：f14dc92193f2ee9a560001a9c265ea7069949241478b62a3b80a428756f8e9cc

返回结果：
- HTTP status：200
- provider code：2002
- provider msg：脚本中捕获为编码错位文本，推断为“无效合同编号.(合同编号不能为空且字符长度不超过40)”

请协助确认：
1. code=2002 是否表示合同编号不合法；
2. uploaddocs.api 的 contract_id 是否要求长度 <= 40；
3. contract_id 是否还有字符集或格式限制；
4. doc_type 是否应传 .pdf 还是 pdf；
5. multipart 文件字段名 file 是否正确；
6. 若 contract_id 长度修正后仍失败，请协助确认摘要公式和 multipart 参数要求。

本报告不包含 app_secret、完整 customer_id、完整 signUrl、身份证号、手机号或 PDF 文件内容。
```
