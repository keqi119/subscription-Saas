# Stage 10D-B2-A Fadada Upload And Sign URL Prep

> Date: 2026-06-25
> Branch: `feature/stage10-fadada-upload-sign-url-prep`
> Scope: contract PDF artifact lookup, mockable Fadada HTTP/API client, `uploaddocs.api`, `extsign_validation.api`, and provider upload/sign URL orchestration.

## 1. Goal

Stage 10D-B2-A prepares the code path for uploading a contract PDF to Fadada and creating a customer signing URL.

This stage still does not call real Fadada endpoints, create real signing tasks, perform real signing, auto-seal, process real callbacks, download signed PDFs, call `contractFiling.api`, add migrations, or change contract/order state-machine outcomes.

## 2. PDF Artifact Audit

Current model support is sufficient without a migration:

- `ContractVersion.fileId` can point to a template or prepared contract PDF file.
- `Contract.fileId` can point to a contract file, currently used by archive flow.
- `ContractESignTask.documentObjectKey`, `signedDocumentObjectKey`, and `evidenceObjectKey` already exist.
- `ContractESignSigner.providerSignerId`, `signUrl`, and `signUrlExpiresAt` already exist.
- `FileObject` stores `bucket`, `objectKey`, `originalName`, `mimeType`, and `sizeBytes`.
- `StorageService.getObject(bucket, objectKey)` can stream private local/OSS files.

There is no existing rendered contract PDF generator. `generateContract` currently stores a `contractSnapshot` and `contentTemplate`, but does not render a PDF.

## 3. Artifact Service

New service:

```text
apps/api/src/esign/contract-pdf-artifact.service.ts
```

The service resolves a PDF buffer in this order:

1. `Contract.fileId`
2. `ContractVersion.fileId`
3. deterministic `TEST_FIXTURE` PDF only when real Fadada sending is disabled and the runtime is test/dev-enabled

Validation:

- file name or MIME type must identify a PDF
- buffer must start with `%PDF-`
- size must be `<=20MB`
- when `FADADA_ENABLED=true`, missing PDF returns `CONTRACT_PDF_ARTIFACT_MISSING` instead of generating a fixture

Production real signing must use a real PDF artifact. The fixture is only for tests and non-real preparation.

## 4. HTTP Client

New wrapper:

```text
apps/api/src/esign/fadada/fadada-http-client.ts
```

Behavior:

- all outbound work goes through an injectable `FadadaTransport`
- default transport uses `fetch`
- `FADADA_ENABLED=false` throws `FADADA_DISABLED` before transport is called
- supports `application/x-www-form-urlencoded;charset=UTF-8`
- supports multipart metadata/file body for PDF upload
- parses JSON response bodies when possible
- does not log `app_secret` or sign URLs

Unit tests use mock transports only.

## 5. API Client

New client:

```text
apps/api/src/esign/fadada/fadada-api.client.ts
```

Implemented methods:

- `uploadDocs`
- `createExternalSignUrl`

`uploadDocs` uses `uploaddocs.api` with:

- `contract_id`
- `doc_title`
- `doc_type=.pdf`
- multipart `file`

`createExternalSignUrl` uses `extsign_validation.api` with:

- `contract_id`
- `customer_id`
- `transaction_id`
- `return_url`
- `notify_url`
- `validity`
- `quantity`

The client validates local request preconditions, keeps raw responses, and does not guess official success codes. Response-code and field confirmation remain TODO before real smoke.

## 6. Provider Flow

`FadadaESignProvider.createSignTask` now:

1. obtains the contract PDF artifact
2. creates a provider contract id from local `taskNo`
3. calls `uploadDocs`
4. creates a customer `transaction_id`
5. calls `extsign_validation.api`
6. returns provider task/envelope IDs, sign URL, artifact object key, raw response snapshots, and signer-level provider id/sign URL

`ESignService` persists returned signer-level data into existing fields:

- `ContractESignTask.providerEnvelopeId`
- `ContractESignTask.providerTaskId`
- `ContractESignTask.documentObjectKey`
- `ContractESignTask.signUrl`
- `ContractESignTask.signUrlExpiresAt`
- `ContractESignSigner.providerSignerId`
- `ContractESignSigner.signUrl`
- `ContractESignSigner.signUrlExpiresAt`

The existing Stage 10D-A state-machine behavior remains unchanged: task creation may move a generated contract to `SIGNING`; no code marks a contract `SIGNED` or moves an order to payment in B2-A.

## 7. getSignerUrl

`FadadaESignProvider.getSignerUrl` currently returns an existing non-expired local signer URL from `ContractESignSigner`.

If there is no local signer URL, or it is expired, B2-A returns `FADADA_SIGN_URL_NOT_AVAILABLE`. Refreshing sign URLs through a real provider request is left for a later confirmed flow.

## 8. New Configuration

```env
FADADA_SIGN_URL_VALIDITY_MINUTES=30
FADADA_SIGN_URL_QUANTITY=1
```

These are examples only. They do not include real credentials.

## 9. Tests

New and updated tests cover:

- `FADADA_ENABLED=false` blocks transport
- mock transport request/response handling
- multipart upload request construction
- PDF validation and size limit
- external sign URL parsing
- PDF artifact lookup from `ContractVersion.fileId`
- missing PDF behavior when real sending is enabled
- deterministic test fixture behavior when real sending is disabled
- provider upload + sign URL orchestration
- stored signer URL retrieval
- `ESignService` persistence of provider signer id and sign URL
- existing Mock provider behavior

## 10. Current TODOs

- production base URL
- official success code / response field confirmation
- endpoint-specific digest formulas for real smoke
- platform enterprise `customer_id`
- customer Fadada `customer_id` mapping
- platform `signature_id` and auto-seal strategy
- real contract PDF template/rendering
- sign URL refresh behavior
- B3 callback verification + idempotency state advancement

## 11. Next Gate

B2-B can proceed only after sandbox credentials, customer id mapping, endpoint response confirmation, and public HTTPS notify/return URLs are available.

B3 can proceed after callback payload mapping, local persistence, and idempotency rules are confirmed.
