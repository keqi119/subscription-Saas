# R3 destination record implementation plan

> **For agentic workers:** Use superpowers:executing-plans for the native integration; delegate the independent pure assessor to the existing bounded helper agent.

**Goal:** Persist the actual R3 destination and replayable observations from the existing H1 creation handle, for the subsequent same-session success/consumer graph.

**Architecture:** Reuse the job-bound hosted reader, native PG/database observations, target locks and existing private object archive/backup. The destination is evidence, not a new signing mechanism or an independently usable capability.

**Tech Stack:** Node ESM, existing private JSON object store and PostgreSQL/Engine observers.

**Spec:** `docs/superpowers/specs/2026-09-28-stage1-r3-target-policy-slice.zh-CN.md`.

## Constraints

- Preserve the approved H1 profile and original UNKNOWN execution; no commercial KMS.
- No business changes, new services, arbitrary target/path arguments or extra database suites.
- Lifecycle remains two namespace reservations until authorized suite execution; do not precreate it to claim completeness.
- Archive nonsecret SELECT/readback originals only; no passwords, request credentials or secret contents.
- Missing/mismatched observations, backup or current identity refuse destination recording; do not release consumed locks.

## Implementation and verification

- [x] Add a pure destination builder/assessor in `scripts/release/r3-destination.mjs`.
      Bind fixed spec/job/session/initial execution, verified hosted bundle,
      actual PG resource/exec readback, manifest-derived database plan and full
      original SELECT transcript, exact physical/namespace lock descriptions.
      Reuse PG/resource and database/role validators, not a second rule set.
- [x] Add no-argument, once-only `recordDestination()` to the existing native
      launch handle. It requires imported hosted evidence and complete initial
      PG/database observations; perform live rechecks before recording.
      Persist canonical observations and destination to archive plus existing
      encrypted backup, independently read back, and retain references for
      subsequent rechecks. Close waits for pending recording and retains locks.
- [x] Extend existing helper/native tests only. First prove missing API or
      mismatched destination refusal, then run affected pure tests and one
      native integration path. Do not repeat R2 or unrelated lifecycle suites.
- [x] Run contract/discovery/syntax/format checks, bounded independent review,
      and update the closeout record. Do not claim actual hosted execution,
      SUCCEEDED, consumption or cleanup until their graph is implemented.

Preflight: clean `3e226f18`; migration status `b005fa` exit 1 because local
`datasource.url` is unset (dotenv disabled, no database connection); schema
validation `c9b98c` exit 0. These edits are release infrastructure only.

## Results

Pure helper RED `869b54` (missing interface) preceded GREEN `352b01`:
existing `r3-database-targets.test.mjs`, 5/5, 1,367.7161 ms. The new cases
cover the complete manifest and real helper SELECT replay with synthetic
responses, mixed-target rejection and an incomplete transcript.

The single affected Linux integration completed naturally (`d68683`),
1/1, 0 skipped, 341,391.7058 ms. `r3-destination-native01.log` retains stdout;
the 269-file private copy `/root/.cache/r3-destination-1WH00J` corresponds to
`20260928-043938-474339759-copy.sha256`. H1 files/TCP/session are native;
GitHub, Engine/PG and database helper responses are synthetic. The SQL matrix
is exercised by the pure helper test, not duplicated through every H1 check.
This is not actual hosted/PG/CI acceptance.

Bounded independent review accepted both native wiring and the pure builder.
Contract verification first reported `CONTRACT_FILE_SET_DRIFT` (`dda5eb`);
adding the new script to the existing catalog resolved it (`f6a559`):
218 files, 83 schemas, 128 migrations, 13 commands, repository digest
`sha256:cd45f29ba45e4130a384a03806880b2d12b1204c1ad81b2fae61116b44c5cef9`.
That registration correction followed native source freezing; destination
implementation bytes remained unchanged. Discovery `861441`: 99 candidates,
39 manifested, 60 excepted, 0 unclassified. Formatting, syntax and diff checks
passed (`2c2a7d`). No new suite/exception, business change, live database write,
service startup, push, merge or workflow dispatch.
