# Stage 2 PDF Readiness For Archived Stage 1 Contracts

## Context

Golden Path order `ORD20260814085019DMGZ` reached customer-confirmed vehicle
handover, then its `GENERATE_SOURCE_PDF` workflow job repeatedly failed with
the sanitized error code `WORKFLOW_ERROR`.

The Stage 1 contract is fully signed and archived. Its current contract status
is `ARCHIVED`, with both the signed timestamp and archived artifact present.
The Stage 2 handover creation gate correctly requires that archived artifact.
However, the later Stage 2 source-PDF generation gate accepts only the
transient `SIGNED` state. The job therefore fails before reserving or rendering
the Stage 2 PDF.

## Decision

Treat both `SIGNED` and `ARCHIVED` as valid completed Stage 1 contract states
when generating the Stage 2 handover PDF.

This matches the existing Stage 2 e-sign readiness policy, which already
recognizes both states, while preserving fail-closed behavior for all earlier,
cancelled, or otherwise invalid contract states.

## Scope

Included:

- update the Stage 2 source-PDF prerequisite to accept `SIGNED` and
  `ARCHIVED`;
- add a regression test proving that an archived Stage 1 contract can generate
  the Stage 2 source PDF;
- keep the existing signed-contract success path and invalid-state rejection;
- after deployment, retry the existing failed workflow job and continue the
  same Golden Path.

Excluded:

- database schema or data migration;
- changing the Stage 1 contract lifecycle;
- reverting archived contracts to `SIGNED`;
- changing handover evidence, PDF contents, Fadada integration, API contracts,
  or UI behavior;
- broad refactoring of Stage 2 readiness services.

## Runtime Behavior

The PDF generation precondition evaluates the related Stage 1 contract:

```text
SIGNED or ARCHIVED
  -> continue Stage 2 PDF reservation and rendering

all other states, missing relation, or deleted/invalid handover
  -> reject with the existing business error
```

No workflow job, handover, contract, or evidence record is rewritten by the
code change itself. Existing retry and idempotency rules continue to own
recovery.

## Test Strategy

Use test-driven development:

1. Add a focused test with the Stage 1 contract status set to `ARCHIVED`.
2. Verify the test fails because the renderer is never reached under the
   current `SIGNED`-only guard.
3. Apply the minimal status-set change.
4. Verify the focused Stage 2 PDF suite, API typecheck, Prisma validation, and
   migration status.

## Staging Recovery And Acceptance

After the API image containing the fix is deployed:

1. verify the running API image matches the intended commit;
2. retry or reactivate the current `GENERATE_SOURCE_PDF` job without creating
   a second handover or customer confirmation;
3. verify one Stage 2 source PDF, contract, and next workflow job are produced;
4. continue field review, Fadada signing, archive, and final delivery steps;
5. verify no duplicate Contract, FileObject, storage object, or e-sign task is
   created.
