# R3 created-target recovery implementation plan

> **For agentic workers:** Use superpowers:executing-plans for this bounded repair. Keep each verified segment reusable.

**Goal:** Prepare a truthful, narrowly scoped disposition for RC 38740679900 and remove demonstrated preparation waste before any new RC.

**Architecture:** Preserve the failed operation and all 39 target/reservation locks. Assess the exact target-create UNKNOWN→SUCCEEDED and session UNKNOWN graph without granting authority. Only a separately approved native policy may later retire the two forward locks. Reuse a postgres administration connection within one resource inspection while retaining every data and identity check.

**Tech stack:** Node.js, node:test, existing H1 protected read-only controls.

**Spec:** Existing incident design `candidate-233d237-rc-PREPARED_STOP/incident-38740679900-readback/DISPOSITION-DESIGN-v2-STOP.md` in the retained H1 preparation directory; raw SHA-256 `acb22ff23165b5facec6fe8fe782dd4e7acd1cad6f60d5ba1b04aa7d25afd2bd`.

## Constraints and review focus

- Current RC authority is consumed. Reconcile failures before any new execution; never replay the failed operation blindly.
- On October 16 the user delegated RAM changes and subsequent plans aligned with Stage1 closure. Prepare exact originals and independently review them, then execute under that standing authority without requesting another per-plan approval. Record the delegation truthfully; do not label an unseen digest as personally approved by the user.
- Target creation is known; remote cleanup is unproved. Neither R3 nor R4 has passed.
- Existing one-UNKNOWN incident policies retain their exact behavior. Pure caller data never becomes native incident authority.
- Reject extra executions/consumptions, changed target locks, or mismatched predecessor bindings; never turn an incomplete graph into success.
- Preserve database identity checks after switching back to an existing connection and close both connections on every outcome.
- Separate observed incident facts, deterministic code defects, and unproved environmental causes. Use targeted tests and required CI only.

## Tasks

- [x] Reconcile the exact 41 lock originals with a bounded protected read; authenticate destination membership and retain all files. Actual graph assessment also passed with 39 target locks and both forward locks still present; independent host protection readback is idle.
- [x] Add a pure created-target incident graph assessor and narrowly typed signed-record semantics in `packages/release-foundation/src/manual-r3-incident.mjs`; test actual assessor acceptance and rejection. Actual retained originals passed a protected read-only assessment.
- [x] In `scripts/release/launch-manual-stage1.mjs`, reuse the postgres administration connection only for one `databaseAdmin` call. The actual private-function regression retains all identity and observation checks; counts are recorded without claiming remote timing improvements.
- [x] Independently review the two changes and run the relevant focused tests once after final edits. PR364 CI passed and the change merged; no additional full local release suite ran.
- [x] Execute and independently read back the exact disposition after formal transport reconciliation. Disposition digest `d3b3ab018ebb5fdff328ea8dfcb7d094334f2874d7f705f5f79fbaac307d1346` retires only the two forward locks and preserves 39 target locks, UNKNOWN history and unproved remote cleanup.
- [x] Measure native historical replay read-only: 133 objects, nine groups and nine slots passed in about 10.8 seconds. This is not the complete signed-to-consumed path.
- [ ] Complete historical trusted-input timing. Eight contexts passed; the new 233d context exposed a manifest/catalog pin mix-up. Correct it using the original Git bytes, retain the passed segment, then read only the corrected context before reviewing the remaining five-minute budget.

Native history integration and the exact registry entry remain explicit, reviewed activation steps under the standing authority. Another build or RC must wait for incident reconciliation and a reviewed phase budget. The real R3 signing path sets issuedAt before context/persistence; consumption then repeats history validation. The ordering regression alone does not establish that this production segment fits 300 seconds. Measure native read-only history cost before another RC and address any demonstrated budget blocker at the smallest useful boundary.

## Preflight

The working branch starts from merged main `119c6bc66a2599b0d3adbe532d9787b79975f969` in the existing diagnostic checkout. Tracked files were clean; unrelated local PR body files remain. Local migration status reports missing datasource configuration; the retained fresh server readback uses the existing Docker configuration and records 126 applied migrations with the two previously authorized closure migrations pending. Prisma validation passes. No business code or schema changes are planned.
