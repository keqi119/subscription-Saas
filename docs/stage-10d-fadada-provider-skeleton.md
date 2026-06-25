# Stage 10D-B1 Fadada Provider Skeleton

> Date: 2026-06-25  
> Branch: `feature/stage10-fadada-esign-provider-skeleton`  
> Scope: Fadada provider skeleton, config validation, digest helpers, callback digest verification, request metadata builders, provider selection, unit tests.

## 1. Goal

Stage 10D-B1 adds the non-network foundation for a future Fadada e-sign adapter.

This stage intentionally does not call real Fadada APIs, upload contracts, create real signing links, advance real callback state, add Prisma migrations, or change the existing contract/order state machine.

## 2. Baseline

Stage 10D-A already introduced:

- `ContractESignTask`
- `ContractESignSigner`
- `ContractESignCallbackLog`
- `ESignProvider`
- `MockESignProvider`
- Portal contract signing APIs and mock signing loop

Stage 10D-B0 is recorded in `docs/stage-10d-fadada-api-audit.md` and remains the interface audit baseline.

## 3. Configuration

The default provider remains:

```env
ESIGN_PROVIDER=mock
```

Fadada skeleton configuration:

```env
FADADA_ENV=sandbox
FADADA_BASE_URL=https://testapi.fadada.com:8443/api/
FADADA_APP_ID=
FADADA_APP_SECRET=
FADADA_API_VERSION=2.0
FADADA_PLATFORM_CUSTOMER_ID=
FADADA_PLATFORM_SIGNATURE_ID=
FADADA_AUTH_PERSON_CUSTOMER_ID=
FADADA_SIGN_NOTIFY_URL=
FADADA_SIGN_RETURN_URL=
FADADA_VERIFY_NOTIFY_URL=
FADADA_VERIFY_RETURN_URL=
FADADA_REQUEST_TIMEOUT_MS=15000
FADADA_ENABLED=false
```

Rules:

- When `ESIGN_PROVIDER` is missing or `mock`, no `FADADA_*` variables are required.
- When `ESIGN_PROVIDER=fadada`, `FADADA_BASE_URL`, `FADADA_APP_ID`, and `FADADA_APP_SECRET` are required.
- Missing config errors list variable names only and do not print secret values.
- `FADADA_ENABLED=false` prevents accidental real use.
- In B1, even `FADADA_ENABLED=true` still must not send network requests.

The current official documentation did not confirm RSA private/public keys or a standalone callback secret, so B1 does not add `FADADA_PRIVATE_KEY_PATH`, `FADADA_PUBLIC_KEY_PATH`, or `FADADA_CALLBACK_SECRET`.

## 4. Digest Helpers

New helpers live under `apps/api/src/esign/fadada`:

- `md5Upper`
- `sha1Upper`
- `base64`
- `formatFadadaTimestamp`
- `sortBusinessParams`
- `buildFadadaMsgDigest`
- `verifyFadadaCallbackDigest`

The base digest helper implements the B0-audited shape:

```text
Base64(SHA1(app_id + MD5(timestamp) + SHA1(app_secret + sort)))
```

Important: Fadada has endpoint-specific digest formulas. B1 provides reusable primitives and request metadata builders only; B2 must confirm each endpoint formula before enabling real HTTP calls.

## 5. Request Builder

The request builder only constructs metadata:

- URL
- endpoint
- method
- content type
- string params
- public params
- `msg_digest`

Covered endpoint metadata:

- `uploaddocs.api`
- `extsign_validation.api`
- `extsign.api`
- `extsign_auto.api`
- `query_sign_result.api`
- `contract_status.api`
- `downLoadContract.api`
- `geturl.api`
- `viewContract.api`
- `contractFiling.api`

It does not read local files, open streams, import HTTP clients, or send requests.

## 6. Provider Skeleton

`FadadaESignProvider` implements the existing `ESignProvider` interface.

Behavior:

- `createSignTask` throws `FADADA_PROVIDER_STAGE_B2_REQUIRED`.
- `getSignerUrl` throws `FADADA_SIGN_URL_STAGE_B2_REQUIRED`.
- `verifyCallback` verifies Fadada form callback digest and maps basic result codes:
  - `3000` -> `FADADA_SIGN_COMPLETED`
  - `3001` -> `FADADA_SIGN_FAILED`
  - `3003` -> `FADADA_SIGN_REJECTED`

The Fadada callback event names are intentionally not added to the Stage 10D-A completion event set in B1. Real callback state advancement belongs to Stage 10D-B3.

## 7. Provider Selection

`ESignModule` now creates the provider client through a factory:

- missing/`mock` -> `MockESignProvider`
- `fadada` -> `FadadaESignProvider`
- unknown values -> `ESIGN_PROVIDER_UNSUPPORTED`

This keeps current mock behavior as the default and makes real-provider selection explicit.

## 8. Tests

New tests cover:

- timestamp formatting
- uppercase MD5/SHA1 helpers
- business parameter sorting
- deterministic local digest fixture
- callback digest verification success/failure
- request builder public param injection
- request builder no-network behavior
- multipart upload metadata
- Fadada config validation
- provider factory default mock behavior
- provider factory Fadada selection
- skeleton Stage B2-required errors
- callback result-code mapping

The deterministic digest fixture is local to this repository and is not an official Fadada sample.

## 9. B2 Requirements

Stage 10D-B2 must not start until these are confirmed:

- sandbox base URL is reachable from the intended environment
- `FADADA_APP_ID` and `FADADA_APP_SECRET`
- platform enterprise `customer_id`
- platform `signature_id` or a confirmed no-auto-seal path
- customer `customer_id` acquisition and real-name flow
- contract PDF generation/upload plan
- endpoint-specific formulas for `uploaddocs.api` and `extsign_validation.api`
- public HTTPS `notify_url` and allowed `return_url` domains

## 10. Open TODOs From B0

- Production base URL: TODO, requires Fadada operations enablement.
- Evidence report / evidence file download endpoint: TODO, not found in the current SPA documentation.
- Reject endpoint naming: TODO, docs showed `reject_by_contract_id.api` text and `contract_reject_sign.api` target.

