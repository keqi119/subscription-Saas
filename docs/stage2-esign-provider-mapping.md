# Stage 2 eSign Provider Mapping

## Scope

This document records the implemented Stage 2 delivery-handover eSign contract. It is the central reference for readiness, typed provider mapping, callback handling, archive behavior, API exposure, and the final delivery gate.

The implementation was verified offline with mocked provider, storage, and Prisma collaborators. This round did not connect to an environment database or call a provider. A controlled provider sandbox remains required before rollout.

## Typed Mapping

| Concern | Customer action | Platform action |
| --- | --- | --- |
| Runtime signing stage | `STAGE2_DELIVERY_HANDOVER` | `STAGE2_DELIVERY_HANDOVER` |
| Prisma signing stage | `STAGE2_DELIVERY_HANDOVER` | `STAGE2_DELIVERY_HANDOVER` |
| Runtime document type | `DELIVERY_HANDOVER` | `DELIVERY_HANDOVER` |
| Prisma document type | `DELIVERY_HANDOVER` | `DELIVERY_HANDOVER` |
| Slot | `STAGE2_HANDOVER_CUSTOMER` | `STAGE2_HANDOVER_PLATFORM` |
| Signer role/type | `CUSTOMER` | `PLATFORM` |
| Provider action | `CUSTOMER_MANUAL_SIGN` | `PLATFORM_AUTO_SEAL` |
| Fadada API action | `extsign.api` | `extsign_auto.api` |
| Provider transaction count | exactly one customer transaction | exactly one platform transaction |

A Stage 2 task contains exactly two required typed signer rows, one for each tuple above. Unknown stages, wrong documents, wrong roles, wrong actions, duplicate or extra slots, and source-binding mismatches fail closed before state advancement. The signer targeted by the current callback and every already-signed signer must have a matching provider transaction. The structurally required platform signer may remain without a provider transaction until the platform auto-seal action is claimed after customer completion.

The customer transaction uploads the generated Stage 2 source PDF and creates the manual-sign action. Platform auto-seal is a separate transaction and can run only for the platform slot after customer completion through the controlled platform-seal action/retry path.

Before either provider action, the service persists a deterministic transaction ID and a leased in-flight claim on the exact typed signer. This makes an early callback correlatable, prevents void from racing a fresh action, and allows the request path to recognize a callback that already reconciled the same transaction. An ambiguous customer initiation retains its claim and retry timestamp for reconciliation instead of falsely declaring local failure after a possible remote success. Once any provider transaction is accepted, the active task cannot be locally voided without a confirmed provider cancellation path.

## Renderer-Owned Coordinates

The persisted generated artifact is the source of truth for Stage 2 coordinates. Caller-supplied customer coordinates are optional consistency assertions; they cannot override the artifact.

- coordinate system: `FADADA_800_1131_TOP_LEFT`;
- origin: top-left;
- page number: zero-based;
- required page: the final persisted PDF page, therefore `pageNumber = pageCount - 1`;
- `x` and `y`: center of the rendered signature or seal box, not its corner;
- dimensions: scaled box width and height;
- coordinate source: `PDFKIT_RENDERER`;
- exactly one customer slot and one platform slot.

The renderer owns box placement and converts PDF coordinates to the 800 by 1131 provider space. Provider mapping must not substitute keywords or hard-coded page coordinates.

## PDF And Evidence Limits

The provider upload and signed-download limit is 20 MB. The internal Stage 2 renderer hard limit is 18 MiB, with a 15 MiB target and a maximum of 100 pages. Readiness rejects a declared source artifact above 18 MiB before provider work.

The visually accepted PDF behavior is:

- all photo evidence is rendered from prepared JPEG derivatives, four photos per attachment page;
- each video receives a manifest entry with source metadata, duration, source SHA-256, and a protected evidence-package reference;
- `WALKAROUND_VIDEO` requires four distinct persisted keyframe derivatives, and those JPEG keyframes are rendered;
- the original video stream is not embedded in the PDF;
- the canonical evidence manifest and source PDF SHA-256 are bound into the generated contract snapshot and eSign request snapshot.

The current visual PDF acceptance has passed. No video embedding beyond the implemented manifest and keyframe behavior is claimed.

## Readiness Contract

`GET` readiness/status responses use stable blocker codes and safe messages. Stage 2 eSign creation requires all of the following:

- the current Stage 1 contract is `SIGNED` or `ARCHIVED`;
- order status is `PENDING_DELIVERY`, with no terminal/delivered state;
- work order is `CUSTOMER_CONFIRMED`, non-terminal, and has no active objection or pending Admin resubmission review;
- the latest review attempt is customer-confirmed and its field-facts snapshot still matches;
- required field facts and evidence are complete;
- the customer-confirmed manifest, current manifest, handover manifest, and generated contract manifest match;
- the generated Stage 2 contract, active delivery-handover template, `FileObject`, artifact version, source PDF hash, MIME declaration, size, and persisted final-page slots are valid;
- customer provider account, real-name verification, certificate, and configured freshness evidence are ready;
- platform customer and signature identifiers are configured;
- no conflicting active Stage 2 task exists.

Readiness is local and fail-closed. It does not generate a PDF, call the provider, create a signing URL, confirm delivery, set `actualDeliveryAt`, activate a lease, or start billing.

## Lifecycle And Callback Contract

Admin explicitly creates the task. The lifecycle persists one typed customer signer and one typed platform signer, preserves source PDF/manifest identity, and supports terminal-task void/rebuild, platform-seal retry, and archive retry. Active tasks with accepted provider transactions remain correlated and fail closed on void.

Verified Stage 2 callbacks:

- correlate through the typed signer `providerTransactionId` and validate provider/contract identity;
- never fall back to legacy task correlation for a typed Stage 2 task;
- remove sensitive fields and redact provider descriptions and URLs before persistence;
- recursively sort object keys, serialize the sanitized payload, and compute SHA-256;
- deduplicate through the provider-scoped canonical payload hash;
- reclaim an identical verified callback when its existing callback log is still unhandled after a rolled-back reconciliation;
- accept customer/platform completion in either order;
- re-read the exact required signer set and retry Serializable reconciliation conflicts;
- complete the task, Stage 2 contract, and handover only when both required typed signers are signed;
- ignore terminal conflicts without reviving a voided, failed, rejected, cancelled, or expired task.

Stage 2 completion does not update `SubscriptionOrder` to Stage 1 `PENDING_PAYMENT`, send a payment-pending notification, confirm delivery, write `actualDeliveryAt`, activate a lease, or start billing.

## Archive Contract

Archive requires a completed typed Fadada Stage 2 task, both required signed signer rows, and an unchanged source identity. The archive path:

- uses an atomic `PENDING` claim;
- treats a fresh claim as in progress;
- uses a five-minute default stale-claim lease and atomically reclaims an expired claim;
- queries/downloads the signed artifact, then validates exact PDF MIME, PDF magic, and the 20 MB limit;
- calculates and persists the signed PDF SHA-256;
- binds a content-addressed object identity to the still-current claim before storage write and then links the signed `FileObject`;
- re-reads committed state after an ambiguous finalization failure, and only compensates a known-uncommitted object while retaining a deterministic reconciliation pointer if deletion is uncertain;
- returns to `SIGNED` with `archiveStatus=FAILED` on retryable archive failure;
- skips duplicate retries after a complete archive.

Provider filing is advisory after the signed PDF is stored.

## API Boundaries

Admin routes require the existing Admin guards plus `delivery:view` for status/state reads and `delivery:confirm` for create, platform retry, archive retry, and void:

- `GET /handover-work-orders/:id/esign`
- `POST /handover-work-orders/:id/esign`
- `POST /handover-work-orders/:id/esign/platform-seal/retry`
- `POST /handover-work-orders/:id/esign/archive/retry`
- `POST /handover-work-orders/:id/esign/void`
- `GET /handover-work-orders/:id/esign/signed-document`

Admin status and signed-document state do not expose a signing URL, provider payload, storage locator, credential, or token.

Portal exposes only:

- `GET /portal/handover-reviews/:id/esign`
- `POST /portal/handover-reviews/:id/esign/signing/start`

The Portal `GET` returns a safe status with mapped customer blockers and no URL. Expected readiness conflicts caused by the already-created current signing task are omitted only when the readiness task, handover, order, and work-order state still match the current read and `capability.canStartSigning` is true, so the response never simultaneously reports that signing is available and unavailable. Only the intentional, customer-owned `POST` start action may return a short-lived signing URL and expiry. Provider URL failures map to `STAGE2_PORTAL_SIGNING_URL_UNAVAILABLE`; customer/action blockers map to stable safe DTOs. There is no optional Stage 2 signed-document preview route in this API surface.

The Web integration uses these boundaries directly. Admin order detail displays readiness, customer signature, platform seal, and archive state, and requires explicit confirmation before provider mutations. Portal handover detail reads the safe status endpoint and exposes `去签署` only when `capability.canStartSigning` is true. It requests the short-lived URL only after that deliberate click and immediately redirects without storing or rendering the URL.

## Final Delivery Gate

eSign never confirms delivery automatically. Final delivery remains an explicit Admin action.

The confirmation transaction uses `READ COMMITTED` and locks gate rows in a fixed parent-to-child `FOR UPDATE` order before re-reading all mutable prerequisites. The gate bridges current evidence to signed evidence by requiring the current evidence manifest to equal the manifest bound to the source PDF and completed eSign task.

`DELIVERY_HANDOVER_ARCHIVE_BLOCKS_DELIVERY_CONFIRMATION` is `false`, but this does not make the signed artifact optional:

- a complete signed artifact, typed task, exact two-signer set, hashes, file identities, and manifest bridge are required;
- `archiveStatus=FAILED` is a warning only when that full signed-artifact state exists;
- a missing or inconsistent signed artifact blocks delivery;
- only successful Admin confirmation writes `actualDeliveryAt`, activates the order, and transitions the vehicle to leased.

## Controlled Sandbox Questions

The following remain unresolved until controlled sandbox validation:

1. How duplicate transaction submissions are treated and which idempotency key is authoritative.
2. How callback retries behave, including customer/platform out-of-order delivery.
3. Whether the configured platform auto-seal authorization and signature remain valid for this action.
4. The observed delay between final signature completion and signed-document download availability.
5. Whether archive/filing retries are idempotent after partial success.

## Open Engineering Notes

- Delivery confirmation remains fail-closed if PostgreSQL aborts a lock-order deadlock, but it has no bounded deadlock/P2034 retry. Add a bounded retry before high-concurrency rollout.
- The third-signer child-phantom unit fixture is not schema-realistic under `(taskId, slotId)` uniqueness. Replace it with a schema-valid malformed child case where possible and retain real-PostgreSQL parent/FK locking coverage.
