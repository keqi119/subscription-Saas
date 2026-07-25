# Stage 1 eSign Review Follow-ups

## Status And Boundary

This document is a remediation backlog derived from the Stage 1 read-only review at commit `7c17367`. The schema-expressiveness compatibility item is closed by the Stage 2 provider-mapping branch without changing Stage 1 runtime behavior. The pre-existing Stage 1 runtime findings remain backlog.

The review found no confirmed Critical issue. It found one Stage 2-branch typed-model compatibility gap, eight pre-existing Stage 1 Important findings, and three pre-existing Stage 1 Minor findings.

## Closed: Typed Compatibility Gap

### P0-1 Typed Stage 1 multi-slot compatibility (schema expressiveness only)

This was the review's single branch-introduced compatibility gap and is intentionally separate from the pre-existing Stage 1 runtime backlog.

- Prisma now uses canonical `STAGE1_BODY_*` slot IDs.
- `CONTRACT_BODY` and `ATTACHMENT1_SUBSCRIPTION_PLAN` are separately expressible document types.
- Signer transaction IDs are no longer globally unique, allowing each Stage 1 shared provider action to cover two signer slots.
- Stage 2 correlation remains uniquely constrained by a partial unique index scoped to active Stage 2 signer slots.

No Stage 1 writer, backfill, dual-write, callback fallback, `PENDING_PAYMENT`, or other Stage 1 runtime behavior changed. Real PostgreSQL migration round-trip coverage remains required before deploying the migration.

## P0: Pre-existing Stage 1 Risks

### P0-2 Cancellation/completion invariant

Cancel active eSign tasks/signers and invalidate URLs in the contract cancellation transaction. Completion must recheck current-contract, contract-status, and order-status invariants. Add cancellation followed by late callback coverage and ensure no contract revival, order advancement, or payment notification.

### P0-3 Mutation authorization and manual-sign guard

Apply one object-level owner/Admin rule to create, archive, and manual-sign mutations. Redesign manual sign as an explicit offline-evidence flow with current-contract/state checks, audit reason, approval authority, and no concurrent active eSign task.

### P0-4 Signing URL containment and recovery

Remove signing URLs from Admin, audit, and callback DTOs; clear them after customer completion and terminal transitions. Add a controlled refresh action with attempt/claim persistence so an expired Fadada URL has a recovery path.

## P1: Idempotency, Retry, And Callback Trust

### P1-1 Task/action claim

Enforce one active task per contract/stage and model auto-seal claim state, attempts, retryable failure, terminal failure, and claim expiry. Cover concurrent create and two-worker auto-seal behavior.

### P1-2 Callback deduplication

Persist a canonical provider-scoped payload hash, claim it transactionally, and verify under concurrency that callback side effects and notifications run once.

### P1-3 Real-name replay protection

Validate callback timestamp windows, deduplicate events, use a finite freshness default, and prevent duplicate or older events from refreshing readiness evidence.

### P1-4 Provider verifier registry

Bind callback route provider, verifier implementation, and persisted task provider. Block production Mock callback handling and cover provider rollover combinations.

## P2: Archive, Notification, And Evidence Integrity

### P2-1 Archive state machine

Add claim/retry/partial-failure handling. Do not present filing failure as complete success, and clean up orphan artifacts left by failed finalization.

### P2-2 Stage 1 hash binding

Persist source and signed PDF SHA-256 values together with provider contract/action identifiers in archive metadata.

### P2-3 Notification outbox

Send only events that match the final committed order state, with an idempotent event key and retryable outbox delivery.

### P2-4 Provider hardening

Make the persisted Stage 1 artifact the coordinate source of truth, validate exact slot/document metadata, and enforce a bounded/streaming 20 MB download path.

## Finding Cross-reference

The backlog above preserves the original review order:

1. typed model compatibility gap: P0-1;
2. cancellation and late callback: P0-2;
3. object authorization/manual sign: P0-3;
4. expired signing URL recovery: P0-4;
5. Admin/audit URL exposure: P0-4;
6. auto-seal retry suppression: P1-1;
7. create/callback/archive concurrency: P1-1, P1-2, and P2-1;
8. real-name replay/freshness: P1-3;
9. provider/verifier mismatch: P1-4;
10. payment-pending notification without a successful state update: P2-3;
11. weak Stage 1 coordinate/slot validation: P2-4;
12. buffered size validation and missing Stage 1 hash binding: P2-2 and P2-4.
