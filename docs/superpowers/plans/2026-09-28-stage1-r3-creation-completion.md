# R3 creation completion implementation plan

> **For agentic workers:** Use superpowers:executing-plans. A bounded Sol helper owns the session and trusted wrapper; the root owns native wiring and the existing integration case.

**Goal:** Record a verified target-create completion in the original R3 session, retaining its original UNKNOWN and all resource locks.

**Architecture:** The native creation handle rechecks live resources before requesting completion by destination digest. The session independently reconstructs the destination from archived and backed-up originals, records technical custody, and appends a linked execution. Existing signing, revocation and consumption stores remain authoritative.

**Tech Stack:** Node ESM, existing manual session and private object stores.

**Spec:** `docs/superpowers/specs/2026-09-28-stage1-r3-target-policy-slice.zh-CN.md`.

## Constraints

- No commercial KMS, business change, new service, database suite or exception.
- Preserve the original UNKNOWN. A completed creation does not prove cleanup or allow snapshot consumption.
- Accept no caller-supplied status, target, timestamps or observations at the native completion entry.
- Derive success only from the same session, original consumption, held target locks and independently replayed destination evidence.
- Do not rerun the completed R2 synthetic chains or unrelated native cases.

## Task 1: Connect completion and its evidence graph

**Files:** `packages/release-foundation/src/manual-stage1-session.mjs`, `scripts/release/manual-stage1-trust.mjs`, `scripts/release/launch-manual-stage1.mjs`, and the existing `scripts/release/manual-stage1-trust.test.mjs` integration.

**Interfaces:** Low-level/trusted `completeCreation({destinationDigest})` returns `{executionRecordDigest,custodyRecordDigests}`. Native `completeCreation()` is argument-free and once-only, returning `TARGET_CREATED` with those digests and `promotionEligible:false`. Optional fixed destination inputs on the low-level session support independent replay; existing creation-only fixtures retain their three-field context.

- [x] Extend the existing native destination test to require the missing completion API; verify the failure before implementation.
- [x] Independently replay the hosted bundle, PG observations, manifest-derived database set and exact target locks using existing validators. Record archive/backup custody after byte readback. Append a v3 SUCCEEDED execution whose predecessor is the initial UNKNOWN; retain all originals.
- [x] Validate the two-execution history explicitly. Do not permit an incomplete, extra or foreign-session graph; keep the old R2 unresolved-history gate.
- [x] Add native once-only completion after live recheck, wait for it during close, and retain all consumed locks. Recheck completion originals on subsequent use.
- [x] Run the one affected Linux integration, appropriate core checks, syntax/format and contract/discovery checks. Review the bounded change and update the closeout record.

## Review focus

- Backup absence or mutation must prevent completion and subsequent use.
- Caller-invented success and cross-session destination objects must be rejected.
- Duplicate or partial completion cannot overwrite UNKNOWN or enable retry.
- Expired/revoked scope and replaced locks must refuse use.
- Creation success cannot release locks or be mistaken for actual hosted acceptance.

Preflight carried from this development round: clean `47fc9273`; `aba01b` migration status exit 1 because local `datasource.url` is absent with dotenv disabled; `362903` Prisma validation exit 0. No database was contacted. This task changes release infrastructure only.

Ruling: reuse the repository-private destination helper from the session through a fixed dynamic import. The runner image already includes both `packages` and `scripts`; moving several existing validators would add unrelated churn. Any consumer packaging this private package alone must also include its repository release scripts.

## Verification and review record

- Native RED `8594ec`: missing `completeCreation` assertion, 0/1/0, test duration 45,504.80578 ms. The original output remains in `r3-completion-red01.log`.
- The first GREEN preparation (`r3-completion-native01`) stopped at copy hash comparison because a helper edited the session after declaring it stable. No test ran. Its partial copy manifest ends with `WRAPPER_FAILURE_EXIT=1 LINE=45`; this is not a test failure or success. Edits were stopped before the next source freeze.
- Seven existing R3 core cases passed (`c50ed3`, total 72,223.5973 ms). Native `r3-completion-native02.log` passed 1/1, 0 skipped, test duration 539,406.993022 ms, naturally exit 0 (`d92c2d`). That frozen source preceded the two review fixes below.
- Bounded independent review found two important mixed-history failures: new R3 object schemas entering the old R2 assessor, and a binary Docker stream entering its UTF-8 raw-input check. Both were fixed by projecting out only independently replayed R3 object/stream digests. The short regression first failed on the missing selector (`0ecfc8`), then passed through the real R2 assessor (`5976d4`); absent validation and unrelated objects/raw bytes still reject. The selector is not exported by the package index and grants no authority.
- Root review also corrected the old slot-schema gate to accept only v3 consumption digests already checked by R3 history. The existing unresolved/reconciled R2 history case passed on the final projection (`070b36`, 65,678.4312 ms total).
- Contract verification `504b47` passed: 218 files, 83 schemas, 128 migrations, 13 commands; digest `sha256:42b604da6f9a2a80064eeb3a4a85eb9e753b605ea3b1b82bc9f858f28118a289`. Discovery `2d527f`: 99 candidates, 39 manifested, 60 excepted, 0 unclassified. No new suite or exception.
- Final exact-source native verification (`2a0db8`) naturally exited 0: `r3-completion-native03.log`, 1/1, 0 skipped, test duration 527,434.613643 ms, total 528,309.285213 ms. The private copy `/root/.cache/r3-completion-5SxkBf` matches `20260928-052043-764618553-copy.sha256`; all 269 source files still match (`d95beb`). Both review fixes are included.

Validation limits: the native case uses actual private Linux files, session records and TCP exchanges, with synthetic GitHub/Engine/PG and the existing bounded database-helper substitute. The projection regression uses the real R2 assessor with offline originals. Neither is actual hosted or live PostgreSQL acceptance. No live database, service, cloud resource, workflow dispatch or business behavior changed.
