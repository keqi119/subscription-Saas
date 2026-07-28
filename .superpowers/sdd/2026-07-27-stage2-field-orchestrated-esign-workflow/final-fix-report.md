# Stage 2 Field-Orchestrated eSign Final Fix Report

Date: 2026-07-28

Branch: `feat/stage2-field-esign-workflow`

Reviewed base: `b8e193787de9b40e2007de3e535ddb388a93b958`

Implementation head before this report: `1912ef14c64a5b760cbf49f394863a9c2fffd785`

## Result

The final-review scope is closed under the product-owner decisions recorded in
this task. I-2 through I-9 and M-1 through M-3 are implemented and covered.
I-1's proposed archive hard gate was explicitly superseded: a completed eSign
may proceed to delivery while archival remains asynchronous.

No push, PR, merge, deploy, staging environment, or real Aliyun/Fadada request
was performed.

## Product Rule Override

### I-1 Signed but unarchived delivery

Decision: superseded by the user's explicit 2026-07-28 rule:

> 电子签已签约，未归档，不阻断交付。

The existing signed-but-unarchived delivery behavior was intentionally
preserved. No `archiveStatus=ARCHIVED` hard gate was added. The default API
suite continues to cover the authoritative delivery path, and no order,
handover projection, or UI capability was changed to contradict this rule.

Commit: no code commit; this is a recorded product decision that overrides the
I-1 recommendation in `final-review.md`.

## Important Findings

### I-2 Canonical Field assignment and backfill

Code:

- `apps/api/prisma/migrations/20260727120000_stage2_field_orchestrated_workflow/migration.sql`
  now uses the real `user_status` value `ACTIVE` and `deleted_at IS NULL`.
- `scripts/stage2-handover-workflow-backfill-core.mjs` and
  `scripts/stage2-handover-workflow-backfill-executor.mjs` perform idempotent
  CAS cleanup of stale inactive/deleted internal snapshots and converge
  conflicts explicitly.
- `apps/api/src/field-operator/field-operator-auth.service.ts` and
  `apps/api/src/handover-work-order/handover-work-order.service.ts` fail closed
  for inactive, deleted, missing, or mismatched internal users.

Tests:

- `apps/api/test/stage2-handover-workflow-schema.spec.ts`
- `apps/api/test/field-operator-auth.spec.ts`
- `apps/api/test/handover-work-order.spec.ts`
- `scripts/stage2-handover-workflow-backfill-core.test.mjs`
- `scripts/stage2-handover-workflow-backfill-executor.test.mjs`

Commit: `017764037ea166fc80f73d621e4ff39537a60ed6`

### I-3 Durable H1 acceptance recovery

Code:

- `apps/api/src/handover-work-order/stage2-handover-esign.service.ts` writes a
  deterministic customer-acceptance recovery job in the same transaction that
  claims H1, persists accepted-operation evidence, retries local finalization,
  and exposes `finalizationPending`.
- `apps/api/src/handover-work-order/stage2-handover-workflow.service.ts`
  recovers the accepted operation through provider query and converges the
  customer notification/reconciliation jobs.
- `apps/api/src/field-operator/field-operator-auth.controller.ts` exposes
  `shouldPollESign`; the Field page polls instead of reporting complete success
  while finalization is pending.

Tests:

- `apps/api/test/stage2-handover-esign-lifecycle.spec.ts` covers provider
  acceptance followed by local finalization failure without mutating the claim
  clock or repeating the POST.
- `apps/api/test/stage2-handover-workflow-recovery.spec.ts`
- `apps/api/test/stage2-field-esign-initiation.spec.ts`
- `apps/web/test/field-handover-pages.spec.ts`
- `apps/web/test/stage2-handover-ui-flow.spec.ts`

Commit: `9ab6941713222145140ce71d0b475a225cf9ca7f`

### I-4 Aliyun SMS uncertainty boundary

Code:

- Prisma schema and the undeployed Stage 2 migration add `SENDING` and
  `UNCERTAIN` to `sms_send_status`.
- `apps/api/src/sms/sms.service.ts` independently commits `SENDING` before the
  provider call. Provider acceptance followed by failed local finalization
  becomes `UNCERTAIN` and is never automatically resent.
- Only an explicit `FAILED` state may be reclaimed. No code claims that Aliyun
  `OutId` is a provider idempotency primitive.
- Partial channel retry remains channel-specific.

Tests:

- `apps/api/test/sms.integration.spec.ts` uses two independent PostgreSQL
  clients and covers provider success followed by local finalization failure.
- `apps/api/test/sms.spec.ts`
- `apps/api/test/stage2-handover-notifications.spec.ts`
- `apps/api/test/stage2-handover-workflow-schema.spec.ts`

Commits:

- `945f960c1e84a0d09e4508ac23fb2ede06b4f623`
- `1912ef14c64a5b760cbf49f394863a9c2fffd785` preserves original causes in the
  final lint cleanup.

### I-5 Stage 2 signing URL non-persistence

Code:

- Stage-aware provider inputs distinguish Stage 1 from Stage 2.
- Stage 2 stores operation/transaction/expiry evidence but writes no signing
  URL to task or signer rows.
- Portal URL retrieval calls the provider live and returns the URL directly.
- Fadada Stage 2 has no database URL fallback. Stage 1 keeps its typed legacy
  URL behavior.

Tests:

- `apps/api/test/stage2-handover-esign-lifecycle.spec.ts`
- `apps/api/test/fadada-provider.spec.ts`
- `apps/api/test/fadada-api-client.spec.ts`
- `apps/api/test/stage2-handover-provider-reconciliation.spec.ts`
- `apps/web/test/stage2-handover-ui-flow.spec.ts`

Commit: `9ab6941713222145140ce71d0b475a225cf9ca7f`

### I-6 Retry schedule and database clock

Code:

- Schema and migration default `maxAttempts` to 6, matching controlled
  recovery.
- The five retry delays are reachable in order: 1m, 5m, 15m, 1h, and 6h;
  dead-lettering happens only after the subsequent exhausted failure.
- Repository enqueue/reschedule/polling receives `delayMs` and computes
  `available_at` from PostgreSQL `now() + interval`.

Tests:

- `apps/api/test/stage2-handover-workflow.worker.spec.ts`
- `apps/api/test/stage2-handover-workflow.repository.spec.ts`
- `apps/api/test/stage2-handover-workflow-recovery.spec.ts`
- `apps/api/test/stage2-handover-provider-reconciliation.spec.ts`
- `apps/api/test/stage2-field-esign-initiation.spec.ts`

Commit: `c8b96eb097aa13309e1e5ba450617ec4dfb24047`

### I-7 Admin controlled recovery and fallback initiation

Code:

- Backend status now publishes authoritative `canVoid`,
  `canReconcileCustomer`, and `canAdminInitiate` capabilities.
- H1 FAILED/REJECTED exposes void/rebuild but not reconcile. Provider-completed
  tasks expose neither action.
- Admin create remains blocked while the assigned Field operator is valid. It
  is allowed only as a backend-rechecked fallback when the Field assignment is
  unavailable.
- The Admin order UI supplies a bounded reason to the existing void endpoint,
  renders "作废并重新发起", and renders "后台兜底发起签署" only when authorized by
  the backend.

Tests:

- `apps/api/test/stage2-handover-esign-lifecycle.spec.ts`
- `apps/api/test/stage2-field-operator-identity.spec.ts`
- `apps/web/test/admin-stage2-handover-esign.spec.ts`
- `apps/web/test/admin-stage2-handover-review.spec.ts`

Commit: `97a36fecc33d345b5b819af701fa1940c4a771a5`

### I-8 Real PostgreSQL callback/query interleaving

Code/test:

- `apps/api/test/stage2-handover-provider-reconciliation.integration.spec.ts`
  creates isolated random fixtures and uses two independently constructed
  Prisma clients.
- A two-party barrier holds both real Serializable transactions after their
  task reads. Backend PIDs prove distinct PostgreSQL connections.
- H1 and H2 each assert the final signer/task/handover/contract state, exactly
  one downstream job, exactly one sanitized QUERY audit, and at least one real
  `P2034` followed by automatic retry.
- Cleanup is fixture-scoped and runs in `finally`.

Commit: `1912ef14c64a5b760cbf49f394863a9c2fffd785`

### I-9 Clean database default test stability

Code/test:

- `apps/api/vitest.config.ts` keeps unit files parallel and places only the four
  real PostgreSQL files in a single-worker database project. This prevents
  unrelated shared-schema SSI/index contention while preserving all
  concurrency inside each database test.
- `apps/api/test/stage2-handover-pdf.spec.ts` replaces the 10,000-iteration
  runtime collision search with a deterministic precomputed collision fixture.
- Stage 2 source-PDF finalization retries a bounded `P2034` without rerendering
  or reuploading and still converges on a concurrent winner.
- `apps/api/test/fleet-ops.integration.spec.ts` no longer depends on another
  file setting `DATABASE_URL`.

Tests:

- Default clean-DB API command: 147 files, 1805 tests, 0 failures.
- Serial API command: 147 files, 1805 tests, 0 failures.
- Source-PDF focused file: 28 tests, 0 failures.

Commit: `1912ef14c64a5b760cbf49f394863a9c2fffd785`

## Minor Findings

### M-1 Stage 1 Fadada status mapping

`sign_status=1` again maps to `SIGNED` in the shared Stage 1 client. Exact
`resultCode=3000` remains enforced only by the typed Stage 2 adapter.

Tests: `apps/api/test/fadada-api-client.spec.ts` and
`apps/api/test/fadada-provider.spec.ts`.

Commit: `9ab6941713222145140ce71d0b475a225cf9ca7f`

### M-2 Canonical handover work-order fixtures

Read-time legacy fallback/mutation was removed. Internal fixtures now declare
their assigned user explicitly, and external fixtures explicitly clear the
internal assignment.

Tests: `apps/api/test/handover-work-order.spec.ts` and
`apps/api/test/stage2-field-operator-identity.spec.ts`.

Commits:

- `017764037ea166fc80f73d621e4ff39537a60ed6`
- `97a36fecc33d345b5b819af701fa1940c4a771a5`

### M-3 IN_APP-first partial retry

The inverse partial-channel test covers IN_APP failure, SMS success, retry of
IN_APP only, and exactly one SMS provider call.

Tests: `apps/api/test/stage2-handover-notifications.spec.ts`.

Commit: `945f960c1e84a0d09e4508ac23fb2ede06b4f623`

## Commits

Implementation commits, oldest first:

1. `017764037ea166fc80f73d621e4ff39537a60ed6` - `fix(stage2): harden field operator assignment backfill`
2. `9ab6941713222145140ce71d0b475a225cf9ca7f` - `fix(stage2): recover accepted signing actions safely`
3. `945f960c1e84a0d09e4508ac23fb2ede06b4f623` - `fix(sms): fail closed across provider uncertainty`
4. `c8b96eb097aa13309e1e5ba450617ec4dfb24047` - `fix(stage2): schedule retries from database time`
5. `97a36fecc33d345b5b819af701fa1940c4a771a5` - `fix(stage2): expose controlled admin recovery actions`
6. `1912ef14c64a5b760cbf49f394863a9c2fffd785` - `test(stage2): verify database reconciliation races`

The documentation-only commit containing this report is intentionally not
self-referential; its exact SHA is returned in the final task response.

## Verification

Database identity is redacted below. No URL or password is recorded.

| Command | Result |
| --- | --- |
| `pnpm prisma:validate` | PASS; Prisma schema valid |
| `pnpm prisma:generate` | PASS; Prisma Client 7.8.0 generated |
| `DATABASE_URL=<fresh-local-db> pnpm --filter @subscription-saas/api prisma:migrate:deploy` | PASS; 69/69 migrations applied |
| `DATABASE_URL=<fresh-local-db> pnpm --filter @subscription-saas/api prisma:migrate:status` | PASS; schema up to date |
| `pnpm stage2-handover-workflow:backfill:test` | PASS; 27/27 |
| `DATABASE_URL=<fresh-local-db> pnpm stage2-handover-workflow:backfill:dry-run` | PASS; 0 exceptions/candidates/updates |
| `DATABASE_URL=<fresh-local-db> pnpm stage2-handover-workflow:backfill:apply` | PASS; converged, 0 remaining |
| Focused Stage 2 API Vitest command | PASS; 18 files / 385 tests |
| Focused Stage 2 Web Vitest command | PASS; 4 files / 77 tests |
| SMS + provider-reconciliation real PostgreSQL suites | PASS; 2 files / 4 tests |
| `DATABASE_URL=<fresh-local-db> pnpm --filter @subscription-saas/api test` | PASS; 147 files / 1805 tests; 112.66s |
| `DATABASE_URL=<fresh-local-db> pnpm --filter @subscription-saas/api exec vitest run --no-file-parallelism --maxWorkers=1` | PASS; 147 files / 1805 tests; 214.05s |
| `pnpm -r lint` | PASS |
| `pnpm -r typecheck` | PASS |
| `DATABASE_URL=<fresh-local-db> pnpm -r test` | PASS; shared 7, Web 275, API 1805 |
| `pnpm -r build` | PASS; shared, API, and Web |
| `git diff --check` | PASS before report commit; rerun after report |

## Preserved Boundaries

- Task 9 recovery/backfill, notification terminal-state handling, and
  idempotency boundaries remain covered and green.
- SMS template codes remain Field `SMS_510815118` and Customer
  `SMS_510795093`.
- Stage 1 eSign behavior and typed Stage 2 separation remain covered.
- No PDF visual layout implementation was changed; only test collision setup
  and database finalization retry behavior changed.
- No runbook was weakened.

## Remaining Concerns

There is no remaining merge-blocking code or test concern under the recorded
I-1 product decision.

Non-blocking observations:

- Prisma's PostgreSQL adapter emits a `pg` deprecation warning during the
  intentionally interleaved relation query: `client.query()` while another
  query is completing. The real transactions, P2034 retry, and cleanup all
  pass. Track this when upgrading to `pg` 9.
- Next.js reports the existing multiple-workspace-lockfile root inference
  warning during build. The production build still completes.
- Real Aliyun/Fadada staging acceptance was intentionally not run because this
  task forbids staging and external-provider execution.
