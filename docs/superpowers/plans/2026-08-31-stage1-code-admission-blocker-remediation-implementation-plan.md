# Stage 1 Code Admission Blocker Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task, with a fresh implementer and a fresh task reviewer for every task.

**Goal:** Remove the remaining Stage 1 code-admission blockers by making candidate workers fail closed, producing durable machine-verifiable billing maintenance-cycle evidence, and making the return/rollout feature contract reproducible from checked-in deployment templates.

**Architecture:** Keep business feature flags separate from worker-runtime isolation. Add a dedicated append-only billing maintenance evidence fact outside the acceptance forbidden-domain set, bind two real reconciliation/enqueue cycles to release, image and database identity, and export those facts through a tested database-backed CLI. Treat the staging image environment file as the declared Stage 1 target profile while preserving safe-disabled local and production defaults.

**Tech Stack:** NestJS, TypeScript, Prisma/PostgreSQL, Vitest, Node.js ESM CLI scripts, Docker Compose, PowerShell/Bash runbook contracts.

**Spec:** `docs/runbooks/stage1-clean-staging-acceptance-database-rollout.zh-CN.md`, `docs/superpowers/specs/2026-07-29-six-month-subscription-automation-design.zh-CN.md`, `docs/superpowers/specs/2026-07-30-three-stage-subscription-capability-roadmap-design.zh-CN.md`, and the post-merge audit at `.superpowers/sdd/stage1-task9-preflight-remediation-20260830/postmerge-stage1-code-acceptance-audit.md`.

## Global Constraints

- The three blocking findings are `CANDIDATE_API_TIMER_ISOLATION_UNPROVEN`, `BILLING_COMPLETED_CYCLE_EVIDENCE_UNAVAILABLE`, and the missing Stage 1 three-stage-return deployment/admission contract. None may be bypassed with a manual waiver or elapsed-time inference.
- `SUBSCRIPTION_CHANGE_WORKER_ENABLED` is an exact-`true` runtime switch. Unset, empty, mixed-case, or `false` leaves the worker inert at initialization, direct `runOnce()` entry, and rescheduling entry.
- Public subscription-change feature flags remain independent. With the worker enabled and extension enrollment disabled, already queued work and reconciliation still drain, but no new extension enrollment is created.
- Billing evidence must be a dedicated typed append-only fact, not `AuditLog`, `SubscriptionAutomationJob`, a Docker log, or a hand-written JSON fixture. The fact table is explicitly outside the Stage 1 forbidden-domain count set.
- A completed evidence cycle is bound to one 64-hex evidence run ID, a 40-hex release SHA, a `sha256:<64hex>` image digest, one database identity hash, and one exact versioned forbidden-domain set hash.
- Each evidence run records at most sequence 1 and 2. A completed fact is inserted only after the real non-dry-run reconciliation and real enqueue operations return and before/after forbidden-domain snapshots are captured. A failure produces no completed fact; already committed idempotent business subtransactions are not misrepresented as rolled back.
- Evidence summaries contain only counts and sorted blocker codes. They must not contain order IDs/order numbers, customer/vehicle data, tokens, URLs, or raw reconciliation items.
- The evidence exporter queries PostgreSQL and conditionally waits for actual rows. It never treats a sleep or timeout expiry as cycle completion. Acceptance requires exactly two non-overlapping completed cycles, `blockedCount=0`, exact source bindings, matching recomputed hashes, and before/after forbidden-domain counts that are unchanged within both cycles.
- `SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED` is fail closed for new writes: only exact `true` enables a new three-stage case. Existing governed facts must continue to project the three-stage UI consistently, including legal-collection and return-manifest e-sign continuation facts.
- `.env.example` and production-safe examples remain disabled by default. `.env.staging.images.example` is the explicit target Stage 1 image-admission profile and must declare every exact post-switch flag required by the clean-acceptance runbook. Checked-in template values are configuration intent, not proof that Staging was deployed or accepted.
- The clean-acceptance runbook may remove its two hard stops only after automated tests prove the corresponding worker isolation and database-backed evidence paths. Candidate overrides must force all write-capable workers and the return gate off; post-switch gates must require the target values exactly.
- Prisma migration history is append-only. Add one migration; do not edit an applied migration or use `prisma migrate reset`. Update every hard-coded migration count and recompute the canonical schema fingerprint from a freshly migrated disposable database.
- Tests touching PostgreSQL must use a newly created disposable test database whose exact name is validated before creation/removal. Do not use the drifted historical `subscription_saas_codex` database for final evidence.
- No image build/deploy and no visual browser acceptance belong to this plan. They begin only after this branch passes the independent whole-branch code-admission audit and main CI is green.

---

### Task 1: Make the subscription-change worker independently fail closed

**Files:**

- Modify: `apps/api/src/subscription-change/subscription-change.worker.ts`
- Modify: `apps/api/test/subscription-change-worker.spec.ts`
- Modify: `apps/api/test/subscription-extension-e2e.spec.ts`
- Modify: `apps/api/.env.example`
- Modify: `apps/api/.env.production.example`
- Modify: `.env.example`
- Modify: `.env.production.example`
- Modify: `.env.staging.example`
- Modify: `.env.production.images.example`
- Modify: `.env.staging.images.example`
- Modify: `docs/runbooks/stage1-active-term-contract-change-release.md`
- Modify: `docs/runbooks/stage1b-contract-extension-renewal-release.md`
- Modify: `docs/staging-deployment-runbook.md`

**Steps:**

1. Add failing tests for unset, `false`, and non-exact values: `onModuleInit()` creates no timer and direct `runOnce()` calls none of reconciliation, enrollment or claim paths.
2. Add/retain a failing test showing exact `true` schedules, reconciles, claims, and schedules the next poll, and exact worker `true` plus extension `false` drains existing work without new enrollment.
3. Run the focused tests and record the expected RED output.
4. Implement one exact-`true` worker predicate and enforce it in `onModuleInit()`, at the beginning of `runOnce()`, and at the beginning of `schedulePoll()`.
5. Make tests that intentionally execute the worker return worker `true` explicitly; do not couple this switch to `SUBSCRIPTION_CHANGE_CONFIG`.
6. Add safe defaults and staged target values to all environment examples, and document that disabling this worker pauses all supported change/closure jobs and requires an API restart.
7. Run focused worker/e2e tests and API typecheck; record GREEN output.
8. Commit only Task 1 changes.

**Verification:**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-change-worker.spec.ts test/subscription-extension-e2e.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

### Task 2: Add the append-only billing maintenance-cycle fact and producer

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260831010000_billing_maintenance_cycle_fact/migration.sql`
- Create: `apps/api/src/billing-automation/billing-maintenance-evidence.types.ts`
- Create: `apps/api/src/billing-automation/billing-maintenance-forbidden-domains.ts`
- Create: `apps/api/src/billing-automation/billing-maintenance-evidence.repository.ts`
- Create: `apps/api/src/billing-automation/billing-maintenance-evidence.service.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.module.ts`
- Modify: `apps/api/src/billing-automation/billing-automation.worker.ts`
- Create: `apps/api/test/billing-maintenance-evidence.service.spec.ts`
- Create: `apps/api/test/billing-maintenance-evidence-schema.spec.ts`
- Modify: `apps/api/test/billing-automation-worker.spec.ts`
- Modify as needed: `apps/api/test/billing-maintenance-evidence-postgres.integration.spec.ts`

**Steps:**

1. Add failing schema and service tests for the typed `COMPLETED` fact, `(evidenceRunId, sequence)` uniqueness, sequence/time/hash/check constraints, JSON-object constraints, and UPDATE/DELETE rejection with SQLSTATE `55000`.
2. Add failing service tests for strict operation order, exact source validation, advisory-lock serialization, sequence 1/2 allocation, safe summary redaction, before/after canonical hashes, and the third-cycle normal-maintenance path without expensive evidence snapshots.
3. Add failing tests proving reconciliation, enqueue, snapshot, and insert failures create no completed fact, and that `blockedCount` is recorded rather than hidden.
4. Add a single append-only migration and Prisma model/enum. Store only public-safe reconciliation/enqueue summaries and the exact before/after forbidden-domain count maps plus their hashes.
5. Implement a versioned forbidden-domain definition matching the clean-acceptance snapshot authority. Prevent list drift with a contract test and document that the new evidence fact is the one controlled exclusion.
6. Implement repository operations for database identity, database time, exact counts, advisory locking, fact lookup/allocation and append-only insert.
7. Implement evidence-mode configuration. When disabled, preserve the current maintenance behavior with no full-domain count query. When enabled, run the real reconciliation then real enqueue while holding only the governance observation/advisory-lock transaction; preserve the existing independent business transaction semantics.
8. Route the billing worker through the evidence service and keep immediate retry/no-job-claim behavior on maintenance failure.
9. Generate Prisma client and run focused unit/schema tests, PostgreSQL integration tests on a fresh disposable database, and API typecheck; record RED/GREEN evidence.
10. Commit only Task 2 changes.

**Verification:**

```powershell
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec vitest run test/billing-automation-worker.spec.ts test/billing-maintenance-evidence.service.spec.ts test/billing-maintenance-evidence-schema.spec.ts test/billing-maintenance-evidence-postgres.integration.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

### Task 3: Export two real billing cycles and replace the runbook hard stop

**Files:**

- Create: `scripts/billing-maintenance-cycle-evidence-core.mjs`
- Create: `scripts/billing-maintenance-cycle-evidence.mjs`
- Create: `scripts/billing-maintenance-cycle-evidence-core.test.mjs`
- Create: `scripts/billing-maintenance-cycle-evidence-postgres.integration.test.mjs`
- Modify: `package.json`
- Modify: `Dockerfile.api`
- Modify: `apps/api/test/api-runtime-media.spec.ts`
- Modify: `docs/runbooks/stage1-clean-staging-acceptance-database-rollout.zh-CN.md`
- Modify: `scripts/stage1-clean-acceptance-runbook-contract.test.mjs`
- Modify: `.env.staging.images.example`
- Modify: `.env.production.images.example`
- Modify: `docker-compose.staging.images.example.yml`
- Modify: `docker-compose.production.images.example.yml`

**Steps:**

1. Add failing exporter tests for 0/1 row, wrong or duplicate sequences/cycle IDs, overlap, old timestamps, blocked cycles, missing/wrong source bindings, changed forbidden counts, wrong hashes/keyset, unsafe summary data, and timeout without facts.
2. Add a failing PostgreSQL integration test that queries actual migrated facts and proves UPDATE/DELETE protection, two-cycle export, and fail-closed binding behavior.
3. Implement deterministic canonical JSON hashing and validation in the pure core module. Implement a bounded database poller in the CLI; completion must be derived only from the two stored facts.
4. Emit a public-safe canonical JSON document containing the exact source binding and two cycle proofs. Write only to stdout; use the runbook's existing create-once private publisher for storage.
5. Package both runtime scripts in the API image and lock their presence with `api-runtime-media.spec.ts`.
6. Add evidence-mode environment keys with default false. During the controlled cutover, bind run ID, actual release SHA, inspected image digest and database identity, then run the exporter against the new database.
7. Replace the hand-written billing JSON/runbook sleep inference and `BILLING_COMPLETED_CYCLE_EVIDENCE_UNAVAILABLE` stop with the tested CLI. Any timeout, source mismatch, blocked cycle or hash/count mismatch must enter the existing rollback path.
8. Update runbook contract fixtures so database-backed CLI output is the only accepted source. Preserve the independent log scan and create-once file permissions.
9. Run exporter, image-media, runbook-contract and API typecheck tests; record RED/GREEN evidence.
10. Commit only Task 3 changes.

**Verification:**

```powershell
node --test scripts/billing-maintenance-cycle-evidence-core.test.mjs scripts/billing-maintenance-cycle-evidence-postgres.integration.test.mjs
pnpm --filter @subscription-saas/api exec vitest run test/api-runtime-media.spec.ts
pnpm stage1:clean-acceptance:runbook:test
pnpm --filter @subscription-saas/api typecheck
```

### Task 4: Make the three-stage return and Stage 1 target profile reproducible

**Files:**

- Modify: `apps/api/src/subscription-closure/subscription-return-governance.service.ts`
- Modify: `apps/api/src/subscription-closure/subscription-closure.projection.ts`
- Modify: `apps/api/test/subscription-return-governance-gate.spec.ts`
- Modify: `apps/api/test/subscription-closure.projection.spec.ts`
- Modify: `apps/web/test/subscription-return-three-stage.spec.tsx`
- Modify: `apps/web/test/deployment-ops-safety.spec.ts`
- Modify: `.env.staging.images.example`
- Modify as needed: other safe-default environment examples
- Modify: `docs/runbooks/stage1-clean-staging-acceptance-database-rollout.zh-CN.md`
- Modify: `scripts/stage1-clean-acceptance-runbook-contract.test.mjs`
- Modify: `docs/runbooks/stage1-return-three-stage-rollout.zh-CN.md`
- Modify: `docs/acceptance/2026-08-25-stage1-golden-path-manual-acceptance-issues.md`

**Steps:**

1. Add failing tests that missing/invalid ConfigService values reject a new governed write, while exact `true` enables it.
2. Add failing projection tests for flag-enabled new cases, flag-disabled legacy cases, and flag-disabled continuation facts including legal collection and return-manifest e-sign tasks. Retain the Web strict-boolean contract.
3. Implement fail-closed exact-`true` return governance and make the projection continuation predicate symmetric with the service predicate without broadening new-write admission.
4. Make `.env.staging.images.example` declare the exact Stage 1 target profile required by the post-switch gate: journey, journey worker, field-video worker, mileage-review worker, handover worker, subscription-change worker and three-stage-return values. Keep root and production-safe defaults false.
5. Add candidate overrides for both new admission flags and add exact post-switch checks. Prove false/missing values use the existing rollback path.
6. Update rollout documentation and acceptance ledger to distinguish code/config readiness from unperformed deployment, runtime, visual and manual acceptance. Do not close any acceptance issue prematurely.
7. Run focused API/Web tests plus runbook contract; record RED/GREEN evidence.
8. Commit only Task 4 changes.

**Verification:**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/subscription-return-governance-gate.spec.ts test/subscription-closure.projection.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/subscription-return-three-stage.spec.tsx test/deployment-ops-safety.spec.ts
pnpm stage1:clean-acceptance:runbook:test
```

### Task 5: Rebaseline migration governance and run the independent code-admission gate

**Files:**

- Modify: `docs/runbooks/stage1-clean-staging-acceptance-database-rollout.zh-CN.md`
- Modify: `scripts/stage1-clean-acceptance-runbook-contract.test.mjs`
- Modify: `scripts/stage1-clean-acceptance-baseline-snapshot.mjs`
- Modify: `scripts/stage1-clean-acceptance-baseline-snapshot.test.mjs`
- Modify as required: Stage 1 audit/acceptance evidence under `.superpowers/sdd/`

**Steps:**

1. Update every hard-coded migration count from 124 to 125 and ensure failure fixtures remain one lower. Do not weaken duplicate, checksum, pending, rolled-back or failed migration checks.
2. Create a uniquely named disposable PostgreSQL database from `template0`, apply all migrations, and recompute the canonical schema fingerprint using the repository script. Update the constant and its exact test expectation.
3. Run Prisma validation/checksum/status against the fresh database and run the complete repository test, lint, typecheck and build gates. Keep test output and logs as evidence; remove only verified test-created temp artifacts.
4. Run the clean-acceptance snapshot, PostgreSQL integration, exporter, runbook contract and runtime-image-media tests against the fresh database.
5. Inspect `git diff --check`, migration immutability, generated artifacts, forbidden-domain parity, environment contract parity and any test skips. Resolve every code-level dead-letter, missing entry, placeholder, or unverifiable admission claim discovered.
6. Dispatch a fresh independent whole-branch reviewer against the original base SHA and final head. The reviewer must explicitly verdict all three original admission blockers, concurrency/failure semantics, secret/PII safety, migration correctness, and whether the branch can proceed to PR/CI.
7. If the reviewer finds any Critical/Important issue, return it to the responsible implementer, re-run covering tests, and obtain a scoped re-review. Do not mark code admission passed while any such issue remains.
8. Commit the final evidence/documentation updates. Report code-admission `GO` only with fresh command outputs and independent approval.

**Verification:**

```powershell
pnpm prisma:validate
pnpm prisma:migrate:checksum:verify
pnpm -r test
pnpm -r lint
pnpm -r typecheck
pnpm -r build
pnpm stage1:clean-acceptance:test
pnpm stage1:clean-acceptance:runbook:test
git diff --check origin/main...HEAD
git status --short --branch
```

## Post-plan release boundary

After Task 5 is approved, use `superpowers:finishing-a-development-branch` to present the integration choice. Only after the resulting PR is merged and main CI is green may a new API/Web image be built and deployed. Full agent-driven browser visual acceptance then runs against that exact deployed SHA/image. The Stage 1 manual acceptance checklist is issued only after the visual gate passes.
