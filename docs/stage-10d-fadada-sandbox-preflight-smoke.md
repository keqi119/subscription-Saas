# Stage 10D-B2-B Fadada Sandbox Preflight And Optional Smoke

> Date: 2026-06-25
> Branch: `feature/stage10-fadada-sandbox-preflight-smoke`
> Scope: sandbox configuration preflight, digest gate review, PDF artifact readiness, notify/return URL gate, and optional upload/sign URL smoke decision.

## 1. Goal

Stage 10D-B2-B checks whether the project is ready to run a real Fadada sandbox `uploaddocs.api` plus `extsign_validation.api` smoke.

Default behavior for this stage is preflight only. A real sandbox call is allowed only when all safety gates are present:

- `FADADA_SANDBOX_SMOKE=1`
- `FADADA_ENABLED=true`
- `FADADA_ENV=sandbox`
- sandbox credentials present
- platform/customer identifiers present or explicitly not required
- HTTPS notify/return URLs present
- test PDF present and safe for sandbox
- endpoint-specific digest formulas confirmed, or user explicitly accepts sandbox trial risk
- explicit user approval recorded

## 2. Baseline

Preflight started from latest `main`.

- `main` includes Stage 10D-B2-A via PR #112.
- Working branch: `feature/stage10-fadada-sandbox-preflight-smoke`.
- Working tree was clean before documentation edits.
- Migration status: up to date, 54 migrations.
- `pnpm release:check`: passed during baseline.

## 3. Env Preflight Result

Local env files checked:

- `.env.fadada.sandbox.local`: missing
- `.env.local`: missing
- `.env`: present, no Fadada smoke keys found
- `apps/api/.env.local`: present, no Fadada smoke keys found
- `apps/api/.env`: missing

Env status matrix:

| Key | Status | Notes |
| --- | --- | --- |
| `ESIGN_PROVIDER` | missing | Required to select `fadada` for real-provider flow |
| `FADADA_ENV` | missing | Must be `sandbox` for B2-B smoke |
| `FADADA_BASE_URL` | missing | Sandbox default should be `https://testapi.fadada.com:8443/api/` |
| `FADADA_APP_ID` | missing | Would be masked if present |
| `FADADA_APP_SECRET` | missing | Would be masked if present |
| `FADADA_API_VERSION` | missing | B1 default is `2.0`, but smoke env was not configured |
| `FADADA_ENABLED` | missing | Must be `true` for smoke |
| `FADADA_PLATFORM_CUSTOMER_ID` | missing | Would be masked if present |
| `FADADA_PLATFORM_SIGNATURE_ID` | missing | Would be masked if present |
| `FADADA_AUTH_PERSON_CUSTOMER_ID` | missing | Would be masked if present |
| `FADADA_TEST_CUSTOMER_ID` | missing | Required for `extsign_validation.api` smoke |
| `FADADA_SIGN_NOTIFY_URL` | missing | Must be HTTPS |
| `FADADA_SIGN_RETURN_URL` | missing | Must be HTTPS |
| `FADADA_SIGN_URL_VALIDITY_MINUTES` | missing | B2-A config default is 30 |
| `FADADA_SIGN_URL_QUANTITY` | missing | B2-A config default is 1 |
| `FADADA_SANDBOX_SMOKE` | missing | Smoke safety switch is off |

Result: **blocked**. Real sandbox smoke was not eligible.

## 4. Credential Matrix

| Credential / identifier | Status | Smoke impact |
| --- | --- | --- |
| Sandbox app id | missing | Blocks all Fadada requests |
| Sandbox app secret | missing | Blocks digest generation for real requests |
| Platform enterprise `customer_id` | missing | Blocks platform-side signing/auto-seal path; may not block customer-only smoke if officially not required |
| Platform `signature_id` | missing | Blocks auto-seal validation |
| Auth person `customer_id` | missing | Blocks enterprise authorization validation if needed |
| Test customer `customer_id` | missing | Blocks customer sign URL smoke |
| Explicit smoke approval | not recorded | Blocks real sandbox call |

No real values were printed or written.

## 5. Digest Formula Confirmation

Current code reviewed:

- `apps/api/src/esign/fadada/fadada-digest.ts`
- `apps/api/src/esign/fadada/fadada-request-builder.ts`
- `apps/api/src/esign/fadada/fadada-api.client.ts`
- `docs/stage-10d-fadada-api-audit.md`
- `docs/stage-10d-fadada-upload-sign-url-prep.md`

Findings:

| Endpoint | Current B2-A implementation | Confirmation status | Smoke decision |
| --- | --- | --- | --- |
| `uploaddocs.api` | Builds multipart request and uses `contract_id` as explicit digest sort string | Not fully confirmed by an official sample digest in repo docs/tests | Block smoke |
| `extsign_validation.api` | Uses explicit MD5 seed `transaction_id + timestamp + validity + quantity` and explicit sort string `customer_id` | Not fully confirmed by an official sample digest in repo docs/tests | Block smoke |

There is no official Fadada sample digest recorded in the repository. Existing digest tests are deterministic local fixtures only. Without official samples or a user-approved sandbox trial, endpoint-specific digest confirmation remains a blocker.

## 6. PDF Artifact Check

Repository scan found PDF files under the workspace, but no file was selected for B2-B smoke.

Result:

- Test PDF: not selected
- Size: not applicable
- Reason: no explicitly approved sandbox test contract PDF was available
- Safety status: existing PDFs were not content-audited for sensitive data and should not be used for Fadada smoke by default

A B2-B smoke PDF must be a test-only contract, `<=20MB`, and contain no real customer sensitive information, identity numbers, or formal production terms.

## 7. Notify / Return URL Check

Env result:

- `FADADA_SIGN_NOTIFY_URL`: missing
- `FADADA_SIGN_RETURN_URL`: missing

Code / route result:

- API route exists: `POST /api/esign/callback/:provider`
- Express urlencoded parser is enabled, so form POST payloads can be accepted.
- B3 is still required for Fadada callback idempotency and state mapping.

Important B3 note:

- `FadadaESignProvider` maps `result_code=3000` to `FADADA_SIGN_COMPLETED`.
- The Stage 10D-A completion event set does not currently include `FADADA_SIGN_COMPLETED`.
- Therefore full signing flow state advancement is not ready and remains a B3 task.

Nginx / domain context:

- Repository examples include production and staging API reverse-proxy configs.
- Controlled domains documented in the repo include `api.subauto.keybox.cloud`, `staging-api.subauto.keybox.cloud`, and `app.subauto.keybox.cloud`.
- This preflight did not make public network probes.

## 8. Sandbox Smoke

Sandbox smoke executed: **no**.

Reason:

- `FADADA_SANDBOX_SMOKE` missing
- `FADADA_ENABLED` missing
- `FADADA_ENV=sandbox` not configured
- app id/app secret missing
- test customer id missing
- notify/return URLs missing
- endpoint-specific digest formula not confirmed with official sample
- approved test PDF not selected
- explicit user approval for real sandbox call not recorded

No Fadada network request was made.

## 9. UploadDocs Result

Not executed.

No `uploaddocs.api` request was sent. No provider response was received or stored.

## 10. ExtSignValidation Result

Not executed.

No `extsign_validation.api` request was sent. No sign URL was generated, opened, printed, or stored.

## 11. Blockers

| Blocker | Status | Required before real smoke |
| --- | --- | --- |
| Sandbox credentials | missing | Provide local ignored env values |
| `FADADA_SANDBOX_SMOKE=1` | missing | Enable only for intentional smoke |
| `FADADA_ENABLED=true` | missing | Required for B2-A HTTP client to send |
| `FADADA_ENV=sandbox` | missing | Must prevent production calls |
| Test customer `customer_id` | missing | Required for sign URL |
| Notify URL | missing | Must be HTTPS and point to controlled API |
| Return URL | missing | Must be HTTPS and point to controlled Portal |
| Test contract PDF | not selected | Provide an approved non-sensitive PDF |
| Endpoint digest formulas | not confirmed | Confirm with official sample or approve sandbox trial |
| Full callback flow | not ready | B3 must add Fadada event mapping and idempotency |

## 12. Gate Decision

B2-B gate passed: **no**.

This stage is complete as a blocked preflight report, but real sandbox upload/sign URL smoke did not pass because required gates were missing.

## 13. Can B3 Start?

Yes, Stage 10D-B3 callback verify + idempotency code preparation can start using mock Fadada callback payloads and local digest fixtures.

B3 should not require a successful B2-B smoke if it stays within callback verification, idempotency, event mapping, and local tests.

Stage 10D-B3 is documented in `docs/stage-10d-fadada-callback-idempotency.md`.

## 14. Can Full Signing Validation Start?

No.

Do not start complete real signing validation until all are true:

- sandbox `uploaddocs.api` succeeds
- sandbox `extsign_validation.api` succeeds
- sign URL can be generated and masked in logs
- callback endpoint B3 is complete
- signed PDF/evidence archive B4 is complete
- enterprise/customer `customer_id` flow is clear
- `signature_id` / auto-seal strategy is clear

## 15. Boundary Confirmation

- No production Fadada environment was called.
- No sandbox Fadada business endpoint was called.
- No real sign URL was generated.
- No sign URL was opened.
- No contract/order state was advanced.
- No payment, billing, write-off, ROE, BaaS, or depreciation logic was touched.
- No Prisma schema or migration was changed.
- No secrets or full provider identifiers were committed.
