# Stage 10D-B2-B-R1 Fadada Sandbox Upload/SignUrl Smoke

> Date: 2026-06-25
> Branch: `feature/stage10-fadada-sandbox-upload-signurl-smoke`
> Scope: controlled client-level sandbox smoke script for `account_register.api`, `uploaddocs.api`, and `extsign_validation.api`.

## 1. Goal

Stage 10D-B2-B-R1 prepares and runs a controlled Fadada sandbox upload/sign URL smoke when local safety gates are enabled.

This stage does not open `signUrl`, does not complete signing, does not advance local contract/order state, does not download signed PDFs, does not archive artifacts, and does not touch payment, billing, write-off, ROE, BaaS, or depreciation logic.

## 2. Official Customer ID Finding

The Fadada sandbox document page was read through a browser:

```text
https://topen.fadada.com/index.html#/portal/documentCenter/MMDYHQLIER/HEF9UM2FSZHMDF7R
```

Confirmed related pages:

| Interface | Purpose | Key fields |
| --- | --- | --- |
| `account_register.api` | Register or look up an account by `open_id`; returns `customer_id` in `data` | `open_id`, `account_type=1` for personal |
| `get_person_verify_url.api` | Get personal real-name verification URL | `customer_id`, `verified_way`, `page_modify`, optional name/id/mobile |
| `apply_cert.api` | Bind real-name verification result to `customer_id` | `customer_id`, `verified_serialno` |

Conclusion: `FADADA_TEST_CUSTOMER_ID` is the Fadada personal `customer_id`. It can be obtained from `account_register.api`. Name, ID card number, and mobile are real-name data and are not required for account registration itself.

## 3. Script

New script:

```powershell
pnpm fadada:sandbox-upload-signurl-smoke
```

Implementation file:

```text
scripts/fadada-sandbox-upload-signurl-smoke.mjs
```

The script:

- reads only `.env.fadada.sandbox.local` by default;
- refuses real calls unless `FADADA_ENABLED=true` and `FADADA_SANDBOX_SMOKE=1`;
- requires `FADADA_ENV=sandbox`;
- requires sandbox/test base URL;
- requires HTTPS sign notify/return URLs;
- generates or loads a local non-sensitive PDF;
- calls `account_register.api` only when `FADADA_TEST_CUSTOMER_ID` is missing and gates are enabled;
- then calls `uploaddocs.api` and `extsign_validation.api`;
- writes only a sanitized result to `.tmp/fadada-smoke/upload-signurl-smoke-result.json`.

## 4. Env Ignore Check

| Check | Result |
| --- | --- |
| `.env.fadada.sandbox.local` tracked by Git | no |
| `.env.fadada.sandbox.local` ignored | yes, `.gitignore` rule `.env.*` |
| secrets printed or committed | no |

## 5. Env Preflight Result

Sanitized env status:

| Key | Status |
| --- | --- |
| `ESIGN_PROVIDER` | present |
| `FADADA_ENV` | present |
| `FADADA_BASE_URL` | present |
| `FADADA_APP_ID` | present |
| `FADADA_APP_SECRET` | present |
| `FADADA_API_VERSION` | present |
| `FADADA_ENABLED` | present, but not `true` |
| `FADADA_PLATFORM_CUSTOMER_ID` | present |
| `FADADA_PLATFORM_SIGNATURE_ID` | present |
| `FADADA_AUTH_PERSON_CUSTOMER_ID` | missing |
| `FADADA_TEST_CUSTOMER_ID` | missing |
| `FADADA_TEST_PERSON_NAME` | present |
| `FADADA_TEST_PERSON_ID_CARD_NO` | present |
| `FADADA_TEST_PERSON_MOBILE` | present |
| `FADADA_SIGN_NOTIFY_URL` | present |
| `FADADA_SIGN_RETURN_URL` | present |
| `FADADA_SIGN_URL_VALIDITY_MINUTES` | present |
| `FADADA_SIGN_URL_QUANTITY` | present |
| `FADADA_SANDBOX_SMOKE` | present, but not `1` |

Preflight result: **blocked**.

Blockers:

- `FADADA_ENABLED=true` is required.
- `FADADA_SANDBOX_SMOKE=1` is required.

## 6. PDF Artifact Check

| Check | Result |
| --- | --- |
| Test PDF | present |
| Content type | `application/pdf` |
| Size | 358148 bytes |
| Full local path recorded | no |
| Committed to Git | no |

## 7. Notify / Return URL Check

The script verified that both configured sign URLs were present and HTTPS before it would allow real calls.

Full URLs are not written to this report.

## 8. Digest Formula Status

Implemented in the smoke script:

- `account_register.api`: `Base64(SHA1(app_id + MD5(timestamp) + SHA1(app_secret + account_type + open_id)))`
- `uploaddocs.api`: uses confirmed B2-A formula with `contract_id` as explicit sort string.
- `extsign_validation.api`: uses confirmed B2-A formula with explicit MD5 seed `transaction_id + timestamp + validity + quantity` and `customer_id` as explicit sort string.

No official sample digest is stored in the repository. Real sandbox response remains the validation mechanism once gates are enabled.

## 9. Sandbox Smoke Result

Sandbox smoke executed: **no**.

| Step | Result |
| --- | --- |
| `account_register.api` | skipped |
| `uploaddocs.api` | skipped |
| `extsign_validation.api` | skipped |
| `signUrl` | missing |

No Fadada HTTP request was made because preflight gates blocked execution.

## 10. Blockers

| Blocker | Required action |
| --- | --- |
| `FADADA_ENABLED` not `true` | Set `FADADA_ENABLED=true` only when ready to call sandbox |
| `FADADA_SANDBOX_SMOKE` not `1` | Set `FADADA_SANDBOX_SMOKE=1` only for intentional smoke |
| `FADADA_TEST_CUSTOMER_ID` missing | Non-blocking for script; when gates are enabled the script will call `account_register.api` using `FADADA_TEST_PERSON_OPEN_ID` or the default sandbox open id |
| Customer real-name binding unknown | If sign URL fails with real-name/customer error, use `get_person_verify_url.api` + `apply_cert.api` or an approved interface-version real-name flow |

## 11. Gate Decision

B2-B-R1 gate passed: **no**.

The script and guarded flow are ready, but real sandbox upload/sign URL smoke did not execute.

B5 must remain blocked until:

- `account_register.api` succeeds or `FADADA_TEST_CUSTOMER_ID` is supplied;
- `uploaddocs.api` succeeds;
- `extsign_validation.api` succeeds;
- signUrl is returned;
- callback/return URLs are reachable;
- customer real-name binding and enterprise seal/auto-sign strategy are clear.

## 14. Production-channel Follow-up

The reused car-rental production channel has since been confirmed for Auto Subscription, including contract API permissions, production host `https://textapi.fadada.com/api2/`, callback/return domains, IP whitelist, enterprise `customer_id`, and `signature_id`.

No already-real-named `FADADA_TEST_CUSTOMER_ID` is available. Stage 10D-C1 therefore prepares a controlled production test signer through `account_register.api` and `get_person_verify_url.api` before any production-host upload/signUrl smoke is attempted. See `docs/stage-10d-c1-fadada-test-signer-realname-prep.md`.

## 12. Boundary Confirmation

- No production Fadada environment was called.
- No sandbox Fadada business endpoint was called.
- No signUrl was generated or opened.
- No local Contract or Order state was advanced.
- No signed PDF was downloaded.
- No artifact was archived.
- No payment, billing, write-off, ROE, BaaS, or depreciation logic was touched.
- No Prisma schema or migration was changed.
- No secrets, full customer IDs, full signature IDs, full URLs, or provider raw responses were committed.

## 13. Verification

Passed:

- `node --check scripts/fadada-sandbox-upload-signurl-smoke.mjs`
- `pnpm fadada:sandbox-upload-signurl-smoke:test`
- `pnpm -r lint`
- `pnpm prisma:validate`
- `pnpm prisma:generate`
- `pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json`
- `pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false`
- `pnpm --filter @subscription-saas/api test`

Blocked by local database/tunnel environment:

- `pnpm prisma:seed` failed with `Connection terminated unexpectedly`.
- `pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma` failed with `Schema engine error`.
- `pnpm release:check` failed at `Prisma migrate status` for the same schema engine error after earlier checks passed.

This verification blocker is unrelated to Fadada HTTP execution; no Fadada sandbox request was made in this R1 run.
