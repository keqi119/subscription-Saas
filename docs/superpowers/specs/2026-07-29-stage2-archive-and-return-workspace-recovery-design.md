# Stage 2 Archive And Return Workspace Recovery Design

Date: 2026-07-29

## Context

The Stage 2 handover contract for order `ORD20260726073922TFHF` is signed by
the customer and platform, and the signed PDF is already stored and visible in
contract management. The order workspace still reports that it is waiting for
archive completion and offers the unsigned source PDF.

The deployed API has the Stage 2 workflow and worker feature switches unset.
The provider callback therefore enqueued an `ARCHIVE_SIGNED_PDF` job, but no
worker consumed it. A previous synchronous typed archive attempt also left the
handover in `FAILED` with a planned object key while the generic e-sign task
retained a valid signed artifact under its own object key.

The current PDF renderer already reserves a 144 point signing area. The signed
historical contract was generated before that renderer change and is immutable.
The source artifact metadata does not currently bind a renderer version, so an
old unsigned source can be reused after a renderer change.

The order workspace currently loads and renders the complete vehicle return
domain whenever the operator has permission, even before delivery.

## Product Rules

1. Customer and platform signature completion is sufficient for Admin delivery
   confirmation. Archive completion remains observable and recoverable, but is
   not a delivery blocker.
2. Field is the normal Stage 2 signing entry. Admin retains the approved
   15-minute fallback entry when Field does not advance the process.
3. A signed PDF is immutable. Historical signed documents are never regenerated
   to adopt a newer layout.
4. A source PDF that has not entered an active signing task may only be reused
   when its renderer version matches the current renderer.
5. Vehicle return UI and API traffic are hidden before delivery. After delivery,
   the workspace exposes a compact return entry. The complete return workflow
   appears only after a return record exists.

## Archive Recovery

The Stage 2 archive worker remains the single asynchronous owner of typed
handover archive completion.

Before downloading another provider artifact, the archive service may adopt the
signed artifact already bound to the same completed e-sign task when all of the
following are true:

- the task is a Stage 2 handover task for the same contract and handover;
- customer and platform signers are both signed;
- the object key belongs to that contract's signed-artifact namespace;
- the stored object is `application/pdf`, starts with `%PDF`, and is no larger
  than 20 MiB;
- the service computes and persists the full SHA-256 hash;
- one transaction creates the `FileObject` and completes the full typed archive
  tuple on the handover.

The recovery is idempotent. A complete typed archive returns without mutation.
An invalid or absent historical object falls back to the normal provider
download path. Storage read/write failures and database finalization failures
receive distinct retry-safe error codes instead of the provider catch-all.

Deployment must explicitly enable:

```dotenv
STAGE2_HANDOVER_WORKFLOW_ENABLED=true
STAGE2_HANDOVER_WORKER_ENABLED=true
STAGE2_HANDOVER_WORKER_CONCURRENCY=1
STAGE2_HANDOVER_WORKER_POLL_INTERVAL_MS=5000
STAGE2_HANDOVER_WORKER_LEASE_MS=120000
```

## Renderer Version Binding

New source artifact metadata stores a numeric `rendererVersion`. Reuse
validation for source generation requires the current renderer version.
Lifecycle and archive validation for an already-created signing task accepts
its historical renderer version so existing signed transactions continue to
archive normally.

The renderer version participates in deterministic source identity. This allows
a legacy unsigned source to be superseded without overwriting it.

## Return Workspace States

The vehicle handover tab uses four explicit return states:

- `HIDDEN`: delivery is incomplete; no return API calls or return UI;
- `ENTRY`: delivery is complete and no return record exists; show one compact
  `车辆退回 / 退车验收` action;
- `WORKFLOW`: a return record exists and is not confirmed; show the existing
  editable return panel;
- `COMPLETED`: return is confirmed; show the panel as read-only history.

Delivery completion is derived from authoritative order/delivery fields, not
permission alone.

## Acceptance

- The historical Stage 2 job can complete from its validated stored signed PDF,
  and the order workspace then selects the signed artifact.
- Archive failures identify provider, storage, or finalization phase.
- New unsigned PDFs use the current renderer and reserve the expanded signing
  area; old signed PDFs are unchanged.
- An undelivered order neither requests return endpoints nor renders return
  controls.
- A delivered order first shows the compact return action and expands to the
  full workflow only after preparation.
- Focused tests, lint, typecheck, API tests, and repository quality gate pass.
