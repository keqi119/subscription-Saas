# Stage 10D-B3 Fadada Callback Verify And Idempotency

> Date: 2026-06-25
> Branch: `feature/stage10-fadada-callback-idempotency`
> Scope: Fadada form callback parsing, digest verification, local task lookup, status advancement, idempotency, and sanitized callback logging.

## 1. Goal

Stage 10D-B3 prepares the real Fadada callback path without calling any Fadada API.

This stage handles signed callback payloads from Fadada and updates existing local e-sign state using current schema fields. It does not download signed PDFs, archive evidence, call `contractFiling.api`, or run a real signing smoke.

## 2. Current Callback Flow Audit

- Callback endpoint: `POST /api/esign/callback/:provider`.
- Request parsing: Nest/Express `urlencoded` parser is enabled, so Fadada form POST bodies arrive as objects.
- Provider verification: `ESignProvider.verifyCallback` returns `verified`, `eventType`, `payload`, `providerTaskId`, and now optional provider contract/result metadata.
- Existing Mock provider behavior remains supported.
- `ContractESignCallbackLog` is sufficient for B3 because it stores provider, event type, provider task id, payload JSON, verified/handled flags, task id, and error message.
- No migration is required for B3.

## 3. Callback Payload

Fadada sign callback payload fields handled in B3:

- `transaction_id`
- `contract_id`
- `result_code`
- `result_desc`
- `download_url`
- `viewpdf_url`
- `timestamp`
- `msg_digest`

`FadadaSignCallbackPayload` accepts string fields plus unknown extra fields for forward compatibility.

## 4. Digest Verification

`FadadaESignProvider.verifyCallback` now:

- accepts object, `URLSearchParams`, and form-urlencoded string payloads;
- requires `transaction_id`, `timestamp`, and `msg_digest`;
- verifies with `verifyFadadaCallbackDigest`;
- returns `verified=false` for missing or invalid digest;
- never prints or stores `app_secret`;
- sanitizes `download_url` and `viewpdf_url` before returning payload for logging.

## 5. Result Code Mapping

| Fadada `result_code` | Provider event | Local handling |
| --- | --- | --- |
| `3000` | `FADADA_SIGN_COMPLETED` | Complete signer/task/contract/order |
| `3001` | `FADADA_SIGN_FAILED` | Mark task failed; do not advance order |
| `3003` | `FADADA_SIGN_REJECTED` | Mark signer rejected and task failed; do not advance order |
| other | `FADADA_SIGN_UNKNOWN` | Log only; do not advance state |

The local `ESignSignerStatus` enum has no `FAILED` value. For `3001`, B3 records failure at task level through `ESignTaskStatus.FAILED`, `failedAt`, `errorSnapshot`, and callback log. The customer signer is not marked `SIGNED`; its prior status is preserved.

The local `ESignTaskStatus` enum has no `REJECTED` value. For `3003`, B3 uses `ESignTaskStatus.FAILED` plus signer `REJECTED`, `rejectedAt`, and `rejectReason`.

## 6. Lookup Priority

Callback lookup order:

1. `transaction_id` -> `ContractESignSigner.providerSignerId`
2. `transaction_id` -> `ContractESignTask.providerTaskId`
3. `contract_id` -> `ContractESignTask.providerEnvelopeId`
4. `contract_id` -> `ContractESignTask.taskNo`

This matches B2-A, where Fadada `transaction_id` is saved to task `providerTaskId` and signer `providerSignerId`, while provider contract id is saved to `providerEnvelopeId`.

Unknown transaction/contract callbacks are logged with `verified=true`, `handled=false`, and no business state advancement.

## 7. Status Advancement

For valid `3000` callbacks on a non-terminal task:

- customer signer becomes `SIGNED`;
- signer `signedAt` is set;
- task becomes `COMPLETED`;
- task `completedAt` is set;
- contract becomes `SIGNED`;
- contract `signedAt` is set if empty;
- order moves from `PENDING_SIGN` to `PENDING_PAYMENT`;
- later order statuses are not overwritten.

For `3001`:

- task becomes `FAILED`;
- task `failedAt` is set if empty;
- `errorSnapshot` records provider result metadata;
- contract is not marked signed;
- order is not moved to payment.

For `3003`:

- signer becomes `REJECTED`;
- signer `rejectedAt` and `rejectReason` are set;
- task becomes `FAILED`;
- contract is not marked signed;
- order is not moved to payment.

## 8. Idempotency Rules

- Repeated `3000` is idempotent and does not rewrite signed/completed timestamps.
- `3001` after `3000` is ignored and does not downgrade signed local state.
- `3003` after `3000` is ignored and does not downgrade signed local state.
- `3000` after `FAILED` is ignored as a terminal conflict and requires manual review.
- `3000` after rejected signer/task is ignored as a terminal conflict and requires manual review.
- Unknown result codes are logged as `handled=false` and do not mutate business state.
- Invalid digest is logged as `verified=false`, `handled=true`, and does not mutate business state.

## 9. Callback Log Sanitization

Every callback creates a `ContractESignCallbackLog`.

Payload sanitization:

- `download_url` is stored as `[redacted-url]`;
- `viewpdf_url` is stored as `[redacted-url]`;
- no `app_secret` is stored;
- no full sign URL is stored;
- identity numbers are not added by this stage.

The log uses existing fields:

- `provider`
- `eventType`
- `providerTaskId`
- `payload`
- `verified`
- `handled`
- `taskId`
- `errorMessage`

## 10. Not Included

B3 does not:

- call real Fadada APIs;
- upload contracts;
- generate or open sign URLs;
- download signed PDFs;
- write `signedDocumentObjectKey`;
- write `evidenceObjectKey`;
- call `contractFiling.api`;
- process evidence reports;
- modify payment, billing, write-off, ROE, BaaS, or depreciation logic;
- add Prisma schema fields or migrations.

## 11. Tests

Coverage added/updated:

- invalid digest does not advance state;
- valid `3000` advances signer/task/contract/order;
- repeated `3000` is idempotent;
- `3001` marks task failed and does not advance order;
- `3003` marks signer rejected and task failed;
- unknown `result_code` logs without advancing state;
- unknown transaction/contract logs without advancing state;
- completed task is not downgraded by later `3001`/`3003`;
- failed/rejected task is not auto-upgraded by later `3000`;
- callback log is created for every callback;
- callback payload sanitizes URL fields;
- Mock provider callback tests still pass;
- no real Fadada HTTP calls are used.

## 12. B4 / B5 Gates

Recommended next stage: Stage 10D-B4 signed PDF / archive preparation.

B4 should cover:

- `query_sign_result.api` / `contract_status.api`;
- `downLoadContract.api` / `geturl.api`;
- private signed PDF storage;
- Portal/admin signed contract download;
- `contractFiling.api` archive trigger;
- evidence report interface TODO.

Full real signing validation must still wait until B2-B upload/sign URL smoke and B4 archive preparation are both ready.
