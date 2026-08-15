# Subscription Journey Database-Clock Lease Guard Fix

## Context

The full API baseline suite exposes three failures in
`subscription-journey.repository.integration.spec.ts`: an expired worker can
still complete, reschedule, or dead-letter a Journey job.

The repository claims and reclaims leases with PostgreSQL
`clock_timestamp()`, but terminal lease operations compare
`leaseExpiresAt > new Date()` through Prisma. Under the current PostgreSQL
session timezone and Prisma driver adapter, the database and application
cutoffs are represented eight hours apart. A lease set by the database to ten
seconds in the past therefore still matches the application-supplied cutoff.

The same application-clock predicate is used by all three Journey job
operations and all three Journey outbox operations.

## Decision

Make PostgreSQL the authoritative clock for every atomic lease transition.
Complete, reschedule, and dead-letter operations for both Journey jobs and
Journey outbox rows will use one database-side `UPDATE` with:

```sql
status = 'PROCESSING'
AND lease_token = <claimed token>
AND lease_expires_at > clock_timestamp()
```

The update count must be exactly one. Any missing, stale, mismatched, expired,
or concurrently replaced lease continues to fail with
`JOURNEY_LEASE_LOST`.

## Scope

Included:

- atomically complete, reschedule, and dead-letter Journey jobs using the
  database clock;
- atomically complete, reschedule, and dead-letter Journey outbox rows using
  the database clock;
- derive completion, delivery, and retry timestamps in those statements from
  `clock_timestamp()`;
- retain the existing bounded error fields, attempt increments, status
  transitions, and exception-record transaction boundary;
- add real PostgreSQL regression coverage for expired job and outbox leases;
- update unit tests that inspect the repository transition SQL.

Excluded:

- database schema or migration changes;
- worker polling, claim ordering, lease duration, retry policy, or max-attempt
  changes;
- Journey step definitions or Golden Path business behavior;
- API, UI, provider, billing, or notification payload changes;
- global PostgreSQL timezone or connection-option changes.

## Atomic Transition Rules

### Job Complete

An active lease may atomically set the job to `COMPLETED`, clear lease and
error fields, and set `completed_at` and `updated_at` from the database clock.
The existing validated result input remains non-persisted because this fix
does not alter the current data contract.

### Job Reschedule

An active lease may atomically increment `attempt_count`, set
`available_at = clock_timestamp() + delay`, persist the sanitized error, clear
the lease, and set `RETRY_SCHEDULED`.

### Job Dead Letter

An active lease may atomically increment `attempt_count`, set `DEAD_LETTER`,
persist the sanitized error, clear the lease, and set completion/update times.
Only after that update succeeds may the existing Journey exception be created,
within the same transaction.

### Outbox Transitions

Outbox complete, reschedule, and dead-letter operations follow the equivalent
rules using `DELIVERED`, `PENDING`, and `DEAD_LETTER`. Retry availability is
also calculated from the database clock.

## Error And Concurrency Behavior

- A wrong token, expired lease, missing row, non-processing row, or newer
  reclaimed lease updates zero rows and raises `JOURNEY_LEASE_LOST`.
- A stale worker cannot overwrite a newer worker's result or create an
  exception after losing its lease.
- The state transition and any Journey exception remain in the caller's
  transaction, so a later failure rolls back both.
- No application-side pre-read authorizes a later update; the database checks
  the lease in the update statement itself.

## Test Strategy

Use test-driven development:

1. Preserve the currently failing real-PostgreSQL job cases as RED evidence.
2. Add equivalent real-PostgreSQL expired outbox lease cases and verify RED.
3. Change one transition family at a time to database-clock SQL.
4. Verify all six expired-lease cases reject and preserve their original rows.
5. Verify valid lease transitions still update exactly once and job dead-letter
   still creates one exception.
6. Run Journey repository, worker, failure-recovery, Golden Path, Stage 2 PDF,
   and full API suites using the dedicated `subscription_saas_codex` database.

## Rollout

This fix ships in the same API-only release as the archived Stage 1 contract
PDF readiness correction. No migration or Web image change is required for the
two runtime fixes. After deployment, the existing Stage 2 PDF workflow job can
be retried through the audited recovery path.
