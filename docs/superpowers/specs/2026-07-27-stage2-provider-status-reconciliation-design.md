# Stage 2 Provider Status Reconciliation Design

> Superseded by
> `2026-07-27-stage2-field-orchestrated-esign-workflow-design.md`.
> This document remains as incident analysis, but it is not an implementation
> baseline.

## Context

Stage 2 handover eSign task `ESG20260726180905RWYU` exposed a recovery gap:

- Fadada delivered verified customer-sign callbacks before the callback fix was deployed.
- The old API rejected those callbacks, leaving the local customer signer in `SIGNING`.
- Fadada now reports `result_code=3000` (`SIGNED`) for the exact provider contract, customer, and transaction.
- The locally stored customer signing URL expired at `2026-07-26 18:39:08 +08`.
- Portal signing start therefore returned HTTP 500 with
  `FADADA_SIGN_URL_NOT_AVAILABLE`, even though the customer had already signed.

The favicon 404 is unrelated and is outside this change.

## Current Control Model

Admin and Portal have different responsibilities:

- Admin creates the Stage 2 eSign task through
  `POST /handover-work-orders/:id/esign`.
- Portal obtains the customer signing entry URL and completes the customer
  signing action.
- The Admin "Start eSign" button is intentionally shown only before a task
  exists.
- After a task exists, Admin actions are derived from signer state. A missed
  callback currently leaves no action between "waiting for customer" and
  "start platform seal".

This design preserves that responsibility split and fills the recovery gap.

## Goals

1. Let an authorized Admin verify and reconcile the customer signing state
   against Fadada for an existing Stage 2 task.
2. Let Portal recover safely when the local signing URL is expired.
3. Advance local state only from an exact, successful Fadada result for the
   bound contract, customer, and transaction.
4. Reuse the same Stage 2 state-transition rules as verified callbacks.
5. Keep reconciliation idempotent and safe when a callback and a status query
   arrive concurrently.
6. Preserve the explicit Admin-controlled platform-seal step.

## Non-Goals

- No scheduled polling or background reconciliation job.
- No direct database repair or synthetic callback creation.
- No new eSign task, PDF upload, or provider transaction for reconciliation.
- No automatic platform seal.
- No database migration.
- No change to delivery confirmation, lease start, billing, payment, or
  accounting side effects.
- No Stage 1 behavior change. Any equivalent Stage 1 recovery gap will be
  recorded separately for later optimization.

## API And UI Design

### Admin

Add:

```text
POST /api/handover-work-orders/:id/esign/customer-status/reconcile
```

The route uses the existing Admin authentication and `delivery:confirm`
permission boundary.

When an active Stage 2 task exists and the customer signer is not locally
 signed, the order detail eSign area shows:

```text
核验客户签署状态
```

The action remains hidden after the customer signer is `SIGNED`. At that point
the existing "Start platform seal" action becomes available.

The response contains the sanitized provider status and the refreshed Stage 2
eSign view. It never exposes provider URLs, customer provider IDs, digests, or
raw provider payloads.

### Portal

Both Stage 2 Portal signing-start paths use the same recovery behavior:

- the dedicated handover review signing endpoint; and
- the existing contract-detail signing endpoint when its current task is a
  typed Stage 2 delivery handover task.

If the local URL is usable, behavior is unchanged.

If the local URL is missing or expired:

1. Query Fadada for the exact bound customer transaction.
2. If Fadada reports `SIGNED` with result code `3000`, reconcile local state
   and return an `alreadySigned` result. The Web page refreshes instead of
   redirecting the customer.
3. If Fadada reports `SIGNING`, issue a fresh signed entry URL for the same
   provider contract and transaction, persist its bounded expiry, and return
   it.
4. If the provider reports `FAILED` or `UNKNOWN`, or the query cannot be
   verified, fail closed with a typed business error. Do not advance state and
   do not return the expired URL.

The Portal displays a concise business message and does not surface an HTTP
500 or provider implementation detail.

## Provider Mapping

Extend the provider abstraction with a signer-status query result containing:

- `status`: `SIGNED | SIGNING | FAILED | UNKNOWN`;
- sanitized result code and description;
- provider contract and transaction identifiers used for local equality
  checks.

For Fadada, `query_sign_result.api` must receive:

- `contract_id` from the task provider envelope;
- `customer_id` from the verified Fadada customer account binding;
- `transaction_id` from the Stage 2 customer signer.

Only `result_code=3000` is accepted as signed.

For a still-signing Stage 2 transaction, a fresh entry URL is generated with:

- the existing provider contract and customer transaction;
- the existing customer and document metadata;
- the persisted Stage 2 source PDF hash;
- the generated artifact's persisted customer signature coordinate;
- the current trusted Portal return URL and configured callback URL.

Refreshing an entry URL must not upload the PDF again or create a new provider
transaction.

## Reconciliation Transaction

The provider-query path and verified-callback path share one Stage 2
customer-signed transition:

1. Reload the typed task and its two required signers inside a serializable
   transaction.
2. Revalidate document type, signing stage, source binding, handover pointer,
   provider contract, signer role, slot, and provider transaction.
3. Mark only the customer signer `SIGNED`.
4. Set the task to `SIGNING`.
5. Set the handover to `PENDING_PLATFORM_SEAL` and record
   `customerSignedAt`.
6. Leave the platform signer `PENDING` with no fabricated provider
   transaction.

If the task already reflects the same or a later state, return idempotently.
Terminal conflicts fail closed.

The callback log remains callback evidence only. Provider queries do not create
fake callback rows. Admin-triggered reconciliation is written to the existing
audit log with the actor, task, work order, sanitized provider status, and
result code.

## Concurrency And Failure Handling

- A callback and provider query may race. Serializable transaction retries and
  state predicates ensure one effective transition.
- Repeated Admin clicks are idempotent.
- `SIGNING` is an observation, not a successful reconciliation.
- `FAILED`, `UNKNOWN`, malformed identifiers, mismatched bindings, network
  errors, and unexpected result codes never mark a signer as signed.
- A refreshed URL is persisted only after it passes the existing safe-provider
  URL validation.
- Provider errors are logged with bounded sanitized codes; customer-facing and
  Admin-facing responses contain no secrets.

## Testing

Add focused tests for:

- Fadada status queries using the exact provider customer, contract, and
  transaction IDs.
- Acceptance of `3000` only.
- Stage 2 URL refresh using the same transaction and persisted signature
  coordinate without PDF upload.
- Admin authorization, visibility, signed reconciliation, still-signing
  no-op, unknown failure, and idempotency.
- Portal already-signed refresh behavior and still-signing URL refresh.
- Callback/query concurrency and terminal-state protection.
- No platform transaction, delivery, lease, billing, or accounting side
  effects after customer-only reconciliation.
- Existing Stage 1 and Stage 2 test suites remaining green.

## Acceptance

After deployment, for order `ORD20260726073922TFHF`:

1. Admin "核验客户签署状态" returns Fadada `SIGNED`.
2. The customer signer becomes `SIGNED`.
3. The task becomes `SIGNING`.
4. The handover becomes `PENDING_PLATFORM_SEAL`.
5. The platform signer remains `PENDING`.
6. Admin displays "发起平台盖章".
7. No delivery, lease, billing, payment, or accounting state advances.

Platform seal, signed-PDF archive, and final delivery acceptance then continue
through their existing explicit Stage 2 actions.
