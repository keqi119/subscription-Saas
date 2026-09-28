# R3 Database Target Set Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for the connected H1 implementation; bounded pure helpers may use the existing subagent. Steps use checkbox syntax for tracking.

**Goal:** Connect the admitted R3 PG handle to creation and observation of all precreated suite databases, including the extra clean-acceptance source and the final application database; reserve lifecycle's two databases for its actual execution.

**Architecture:** Read the existing manifest through the held H1/H2 policy reader, derive deterministic names using the existing suite naming rule, and execute fixed SQL through the already bound PG connector. Keep creation UNKNOWN and retain partial resources on failure. Lifecycle's two internal databases remain explicit reservations until that suite creates and cleans them during execution.

**Tech Stack:** Node.js ESM, existing PostgreSQL connector and release-foundation SQL/naming utilities, PG17.

**Spec:** `docs/superpowers/specs/2026-09-28-stage1-r3-target-policy-slice.zh-CN.md`.

## Global Constraints

- NO COMMERCIAL KMS; preserve the approved H1 profile, signing identity and one build proof.
- No business changes, new suite, external grant service, caller-selected endpoint or SQL.
- Read all 37 manifest suites; batches cover only 30 and cannot define the complete set. Precreate 35 ordinary suite databases plus clean-acceptance source/target (37 total), reserve lifecycle's two, and add one independent application database only in final.
- Native entry accepts no overrides and runs only once after this handle's PG creation.
- Roles are database-specific, NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOINHERIT/NOREPLICATION/NOBYPASSRLS; runtime cannot own the database/schema or create schema objects.
- Each CREATE DATABASE is a separate statement outside a transaction; no automatic rollback/drop or new operation retry on uncertain results.
- Creation observations do not prove migrations, snapshot restore, destination admission, target locks, consumer authority or cleanup.

## Review Focus

- Missing or duplicate suite assignments must be rejected before SQL; include source-target topology and every unbatched suite.
- A wrong cluster/DB OID/marker/role observation must reject the result; no caller-provided identity substitutes.
- Password-bearing SQL and credential bytes must not enter diagnostics or returned facts.
- Lifecycle must still execute its actual create/drop/sibling-isolation assertions; reservations carry no OID or created marker.
- Partial failure, repeat calls and closure must preserve UNKNOWN and retain resources for the later verified cleanup path.

## Task 1: Deterministic plan and bounded SQL provisioning

**Files:** new `scripts/release/r3-database-targets.mjs` and `scripts/release/r3-database-targets.test.mjs`.

**Interfaces:** derive a plan from operationRef/phase/chain and a validated manifest. Provision the plan with internal callbacks for fixed SQL, private credential creation, recheck and observation custody; no native authority is exported by these helpers.

- [x] Pin full suite coverage, topology, role isolation and lifecycle reservations with focused tests.
- [x] Implement naming/plan and sequential fixed SQL; read actual OID/marker/owner/role attributes and reject mismatches.
- [x] Cover incomplete SQL and identity drift without automatic DROP or successful result.

## Task 2: H1 connected entry

**Files:** `manual-stage1-trust.mjs`, `launch-manual-stage1.mjs`, existing `manual-stage1-trust.test.mjs`, candidate catalogs.

**Interfaces:** `launchR3TargetCreate(...).provisionDatabases()` takes zero arguments, requires this handle's completed PG observation, and permits one attempt. Held manifest bytes flow through existing policy/spec/job readers. Credentials stay in the original H1 private operation directory; fixed 127.0.0.1:55441 connections use the existing provisioner.

- [x] Add the held manifest facts and connect the helper to the native handle.
- [x] Check cluster identity before mutations, retain raw nonsecret observations and recheck created identities.
- [x] Extend one existing native H1 fixture to prove sequencing, fixed target use, once-only behavior and rejection on identity/credential drift; helper tests retain partial failure without cleanup. Do not rerun R2 long chains.

## Task 3: Required gates and continuation

- [x] Run focused helper/native tests, contract verification, database-test classification, syntax/format/diff checks.
- [x] Document the exact implemented boundary and retained failures; persist the commit and checkpoint at the end of this round.
- [ ] Continue next with actual target locks, destination/success/custody/consumer/cleanup graph, hosted workflow and real same-candidate gates. Do not mark Stage 1 complete after this plan alone.

## Bounded Review and Verification

- Sol medium implemented the pure helper; Sol high reviewed the connected boundary without running another test suite. Both roles stayed within the approved scope.
- Review found the missing incoming role-grant direction and the missing durable attempt before the first credential/SQL. Both were implemented: read `pg_auth_members.member` and `roleid`, require both counts zero; archive the nonsecret plan and original marker time first.
- The incoming-grant regression was RED (2 pass / 1 fail, missing expected rejection) and GREEN after the SQL/readback fix (3 pass / 0 fail / 0 skip, 1,331.3963 ms). Logs: `r3-database-targets-membership-red.log` and `r3-database-targets-membership-green.log` in the existing runner-second-stage scratch directory. These are simulated SQL tests, not a real PG gate.
- Native attempt 01 failed with `R3_TARGET_CREATE_UNAVAILABLE` (0 pass / 1 fail, 132,709.559941 ms). Its private copy and log are retained. Attempt 02 (107,858.457508 ms, 0 pass / 1 fail) located `MANUAL_OPERATION_INPUT_UNAVAILABLE` in PROVISION after credential creation and before the database connection.
- Root cause: strict private pins bind parent directory metadata. Creating the database-credential child directory invalidated the held provisioner pin, and creating later sibling files would likewise invalidate earlier role pins. The fix reserves the empty child directory before pinning the PG password, then writes the full planned credential set before pinning any role file. No shared private-file check was relaxed. Native attempt 03 verifies the revised ordering and later tamper rejection.
- Native attempt 03 naturally exited 0 (`005dfa`): 1 pass / 0 fail / 0 skip, 182,498.126631 ms. Private copy `/root/.cache/r3-database-targets-xoMG3k`; 260 source files matched `20260928-030457-619529185-copy.sha256`. Real Linux filesystem/TCP with synthetic Engine/PG/GitHub responses and a mocked SQL helper; not a real PG or hosted gate. No production changes followed this pass.
- Final contracts (`a69d4b`) passed: 213 files, 83 schemas, 128 migrations, 13 commands; repository digest `sha256:059c40ad8be83a14fb1b8be0bfb182a592cfa98ee54f6c23a9a9a00358a6e694`. Staged discovery (`a9b07d`) passed: 99 candidates, 39 manifested, 60 excepted, 0 unclassified. No new exception or suite. Targeted syntax/diff (`e3b3f8`) and code formatting (`7841c8`) passed.
- Round preflight remains: migrate status exit 1 for missing `datasource.url` with dotenv/URL disabled (`06d6aa`); Prisma validate exit 0 (`deb27f`). No database connection or business change in this slice.
