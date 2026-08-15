# Subscription Journey Database-Clock Lease Guard Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent expired or stale Journey job and outbox workers from completing, rescheduling, or dead-lettering work by making PostgreSQL the sole clock for every lease-guarded terminal transition.

**Architecture:** Replace the six Prisma `updateMany` transitions that compare `leaseExpiresAt` with an application `Date` by parameterized, atomic PostgreSQL updates guarded by `lease_expires_at > clock_timestamp()`. Keep all state changes in the caller transaction, preserve the existing lease-lost error contract, and calculate retry timestamps from the same database clock.

**Tech Stack:** TypeScript, NestJS, Prisma SQL, PostgreSQL, Vitest, real-database integration tests.

## Global Constraints

- PostgreSQL `clock_timestamp()` is authoritative for lease validity and timestamps written by these transitions.
- Each transition must be one atomic update guarded by row id, `PROCESSING` status, lease token, and unexpired lease.
- An update count other than one must raise `JOURNEY_LEASE_LOST`.
- Do not add an authorization pre-read or split the guard and mutation into separate statements.
- Preserve existing statuses, attempt increments, bounded error fields, lease cleanup, and Journey exception behavior.
- Do not change schema, migrations, claim ordering, lease duration, retry policy, Journey steps, API contracts, or UI.

---

### Task 1: Prove Expired Job And Outbox Leases Are Rejected

**Files:**
- Modify: `apps/api/test/subscription-journey.repository.integration.spec.ts`

**Interfaces:**
- Consumes: the dedicated PostgreSQL test database and `SubscriptionJourneyRepository` lease transition methods.
- Produces: real-database RED coverage for all six expired-lease transitions.

- [ ] **Step 1: Preserve the existing expired job lease cases**

Keep the parameterized `completeJob`, `rescheduleJob`, and `deadLetterJob` test as the baseline failure. Confirm each case sets the lease expiry with PostgreSQL `clock_timestamp() - interval '10 seconds'` and expects `JOURNEY_LEASE_LOST` without changing the row.

- [ ] **Step 2: Add equivalent expired outbox lease cases**

Create a PROCESSING outbox row with a lease token, move its expiry ten seconds into the past using raw PostgreSQL, and parameterize:

```ts
completeOutbox
rescheduleOutbox
deadLetterOutbox
```

For each operation, expect `JOURNEY_LEASE_LOST`, then verify status, attempt count, delivery/retry timestamps, and lease ownership remain unchanged.

- [ ] **Step 3: Run the integration file and verify RED**

Run with `DATABASE_URL` pointing to `subscription_saas_codex`:

```powershell
pnpm --filter @subscription-saas/api test -- subscription-journey.repository.integration.spec.ts
```

Expected: all six expired-lease operations fail because the current repository uses an application `Date` cutoff.

---

### Task 2: Implement Atomic Database-Clock Job Transitions

**Files:**
- Modify: `apps/api/src/subscription-journey/subscription-journey.repository.ts`
- Modify: `apps/api/test/subscription-journey.repository.spec.ts`

**Interfaces:**
- Consumes: Prisma transaction client, job id, lease token, retry delay, sanitized error, and dead-letter exception input.
- Produces: one guarded SQL update per job transition and the existing repository return/error behavior.

- [ ] **Step 1: Update unit expectations for SQL job transitions**

Replace `updateMany` mocks and application-time predicate assertions for `completeJob`, `rescheduleJob`, and `deadLetterJob` with `$executeRaw` result-count assertions. Verify SQL uses bound inputs and retains the expected status, attempt, error, retry, and lease-clear semantics.

- [ ] **Step 2: Verify the job unit tests fail**

```powershell
pnpm --filter @subscription-saas/api test -- subscription-journey.repository.spec.ts
```

Expected: the new `$executeRaw` expectations fail against the Prisma `updateMany` implementation.

- [ ] **Step 3: Implement `completeJob`**

Use a parameterized update guarded by:

```sql
id = ${jobId}
AND status = 'PROCESSING'
AND lease_token = ${leaseToken}
AND lease_expires_at > clock_timestamp()
```

Set `COMPLETED`, clear lease/error fields, and set completion/update timestamps from the database clock. Require an update count of one.

- [ ] **Step 4: Implement `rescheduleJob`**

Use the same guard, increment `attempt_count`, set `RETRY_SCHEDULED`, persist the bounded error, clear the lease, and calculate `available_at` from `clock_timestamp()` plus the bound delay.

- [ ] **Step 5: Implement `deadLetterJob`**

Use the same guard, increment attempts, set `DEAD_LETTER`, persist the bounded error, clear the lease, and set completion/update timestamps from the database clock. Require success before recording the existing Journey exception in the same transaction.

- [ ] **Step 6: Verify job unit and integration cases turn GREEN**

Run both Journey repository test files. Expected: valid leases transition exactly once and the three expired job leases raise `JOURNEY_LEASE_LOST`.

---

### Task 3: Implement Atomic Database-Clock Outbox Transitions

**Files:**
- Modify: `apps/api/src/subscription-journey/subscription-journey.repository.ts`
- Modify: `apps/api/test/subscription-journey.repository.spec.ts`

**Interfaces:**
- Consumes: Prisma transaction client, outbox id, lease token, retry delay, and sanitized error.
- Produces: one guarded SQL update per outbox transition and the existing repository return/error behavior.

- [ ] **Step 1: Update unit expectations for SQL outbox transitions**

Change the existing parameterized lease-guard test and valid-transition tests to mock `$executeRaw`, check the result count, and assert the database-clock predicate is present.

- [ ] **Step 2: Implement outbox complete, reschedule, and dead-letter**

Apply the same atomic guard to all three operations. Preserve `DELIVERED`, `PENDING`, and `DEAD_LETTER`; preserve attempt/error/lease cleanup behavior; derive delivered, retry, and update timestamps from `clock_timestamp()`.

- [ ] **Step 3: Verify all six integration cases turn GREEN**

Run the repository unit and integration files. Expected: the complete file passes, including expired job and outbox leases and valid lease transitions.

---

### Task 4: Verify The Baseline And Stage 2 Fix Together

**Files:**
- No additional production files expected.

**Interfaces:**
- Consumes: the dedicated `subscription_saas_codex` database and the full repository worktree.
- Produces: evidence that the baseline fix did not regress the Stage 2 archived-contract fix or other packages.

- [ ] **Step 1: Run focused Journey and Stage 2 suites**

```powershell
pnpm --filter @subscription-saas/api test -- subscription-journey.repository.spec.ts subscription-journey.repository.integration.spec.ts subscription-journey.worker.spec.ts subscription-journey-failure-recovery.spec.ts stage2-handover-pdf.spec.ts stage2-handover-workflow-recovery.spec.ts stage2-handover-esign-readiness.spec.ts
```

- [ ] **Step 2: Run static and database checks**

```powershell
pnpm prisma:validate
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Expected: schema valid, API typecheck passes, and all 90 migrations are applied to the dedicated test database.

- [ ] **Step 3: Run full package test suites**

Run shared, Web, and the complete API suite with bounded worker concurrency and the dedicated database. Expected: no baseline or changed-code failures.

- [ ] **Step 4: Review the final diff**

Verify `git diff --check`, inspect all changed SQL and tests, and confirm there is no schema, UI, global timezone, or unrelated formatting change.

- [ ] **Step 5: Commit the baseline repair**

```powershell
git add -- apps/api/src/subscription-journey/subscription-journey.repository.ts apps/api/test/subscription-journey.repository.spec.ts apps/api/test/subscription-journey.repository.integration.spec.ts
git commit -m "fix: guard journey leases with database clock"
```

---

### Task 5: Publish The Reviewed Branch

**Files:**
- No repository content changes expected.

- [ ] **Step 1: Push the branch**

Push `fix/stage2-archived-contract-pdf-20260815` to origin without force.

- [ ] **Step 2: Create the pull request**

Open a PR targeting `main` that describes both fixes separately:

1. archived Stage 1 contracts are valid inputs for Stage 2 handover PDF generation;
2. Journey terminal lease operations now use the PostgreSQL clock atomically.

Include focused and full-suite verification evidence. Do not merge or deploy until separately authorized.
