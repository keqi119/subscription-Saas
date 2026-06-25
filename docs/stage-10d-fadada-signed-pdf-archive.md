# Stage 10D-B4 Fadada Signed PDF Archive

> Scope: signed PDF query/download/archive preparation, private storage, admin/Portal download surfaces, mocked client tests, and documentation.

Stage 10D-B4 prepares the post-signing artifact path for Fadada tasks.

This stage does not call real Fadada APIs, does not download a real provider PDF, does not fabricate an evidence report, does not add Prisma migrations, and does not modify the contract/order state machine.

## 1. Goals

- Add mockable Fadada signed-result query methods.
- Add mockable signed contract download and `contractFiling.api` client methods.
- Archive signed PDFs to private `StorageService` storage.
- Store only local artifact object keys in existing `ContractESignTask.signedDocumentObjectKey`.
- Expose admin and Portal signed PDF streaming endpoints.
- Avoid exposing Fadada `download_url` / `viewpdf_url` and OSS public URLs.

## 2. Fadada Client Coverage

`FadadaApiClient` now prepares:

- `querySignResult` -> `query_sign_result.api`
- `queryContractStatus` -> `contract_status.api`
- `downloadSignedContract` -> `downLoadContract.api`
- `createContractFiling` -> `contractFiling.api`

All tests use mocked transport. `FADADA_ENABLED=false` still prevents outbound transport calls.

Endpoint-specific digest formulas for B4 download/status endpoints remain TODO for real sandbox validation. The client keeps raw provider responses for audit snapshots, but archive snapshots sanitize URL-bearing values.

## 3. Archive Flow

`FadadaSignedArtifactService.archiveSignedContract`:

1. Loads the `ContractESignTask`.
2. Requires provider `FADADA`.
3. Requires task `COMPLETED`, unless `force=true`.
4. Uses `providerEnvelopeId` as Fadada `contract_id`.
5. Queries sign result.
6. Downloads the signed PDF through the mockable Fadada client.
7. Verifies PDF magic bytes and size.
8. Stores the PDF through private `StorageService`.
9. Updates `signedDocumentObjectKey`.
10. Calls `contractFiling.api` via the mockable client and records sanitized metadata.
11. Leaves `evidenceObjectKey` unchanged because the independent evidence report download API is still TODO.

The archive service does not update `Contract.status`, `Contract.signedAt`, `SubscriptionOrder.orderStatus`, payment, billing, write-off, ROE, BaaS, or depreciation state.

## 4. Storage

`StorageService` now has e-sign artifact helpers:

- `putContractSignedArtifact`
- `getContractSignedArtifactStream`

Object key shape:

```text
contracts/{contractId}/esign/fadada/signed/{yyyy}/{uuid}-signed.pdf
```

Artifacts are private storage objects. API endpoints stream files and do not expose object keys or public object storage URLs.

## 5. Admin API And UI

Admin endpoints:

- `POST /api/esign-tasks/:id/archive-signed-artifacts`
- `GET /api/esign-tasks/:id/signed-contract/preview`

Permissions:

- archive: `contract:archive`
- preview/download: `contract:view`

The admin contract detail e-sign task area now shows signed artifact archive status and provides archive/download buttons when conditions are met.

## 6. Portal API And UI

Portal endpoint:

- `GET /api/portal/contracts/:id/signed-document/preview`

Rules:

- customer auth required;
- current customer can access only their own contract;
- contract must be `SIGNED`;
- signed artifact must exist;
- response is streamed PDF;
- object keys and provider URLs are never returned.

The Portal contract detail page shows signed contract download only when the local signed artifact exists. Otherwise it shows that the signed file is still being generated.

## 7. Idempotency

- Existing `signedDocumentObjectKey` + `force=false` -> skip with `SIGNED_PDF_ALREADY_ARCHIVED`.
- `force=true` -> downloads again and stores a new object key.
- Existing signed artifact references are not overwritten in storage.
- Evidence artifact is not faked.

## 8. Tests

Coverage added/updated:

- query sign result through mocked transport;
- query contract status through mocked transport;
- signed PDF download accepts PDF buffer;
- signed PDF download rejects non-PDF provider responses;
- contract filing client uses mocked transport;
- archive requires completed Fadada task;
- archive stores PDF to private storage;
- archive is idempotent when signed artifact exists;
- archive does not modify contract signed time or order status;
- admin can stream signed PDF without objectKey exposure;
- Portal customer can stream own signed PDF;
- Portal customer cannot stream another customer's signed PDF;
- provider URL-bearing raw payloads are sanitized in archive snapshot;
- evidence report remains TODO and is not fabricated.

## 9. Not Included

- No real Fadada HTTP call.
- No real provider PDF download.
- No real `contractFiling.api` call.
- No independent evidence report download.
- No Prisma migration.
- No contract/order state-machine change.
- No production deploy.

## 10. B5 Gate

Do not enter full real signing validation until these are closed:

- `FADADA_APP_ID` / `FADADA_APP_SECRET` present;
- enterprise `customer_id` present;
- customer `customer_id` flow confirmed;
- `signature_id` / auto-seal strategy confirmed;
- `uploaddocs.api` sandbox smoke passed;
- `extsign_validation.api` sandbox smoke passed;
- notify/return URLs configured;
- callback endpoint B3 complete;
- signed PDF archive B4 complete.

If the sandbox smoke blockers remain open, the safer next step is Stage 10D-B4-B artifact archive smoke with mocked provider payloads.

## 11. B4-B Mock Smoke Result

Stage 10D-B4-B is recorded in `docs/stage-10d-fadada-artifact-archive-mock-smoke.md`.

Result: mocked archive smoke passed with an in-memory completed Fadada task fixture, mocked provider payloads, mocked private storage, idempotency checks for `force=false` and `force=true`, admin/Portal preview service checks, and contract/order/finance no-side-effect assertions.

This B4-B result still does not call real Fadada APIs and does not unblock B5 by itself. B5 remains gated by the B2-B sandbox upload/sign URL blockers.
