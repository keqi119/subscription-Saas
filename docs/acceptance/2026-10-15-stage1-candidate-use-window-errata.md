# R3 candidate-use window and lost diagnostics

RC 38740679900 used candidate `233d237` and the approved one-time replacement.
It passed local collection/rendering/freezing and reached H1 execution, then
failed. The RC is cancelled. Its approval is consumed and does not permit
another run. No R3 chain or R4 acceptance is established by this correction.

## Observed boundary

Protected read-only inspection authenticated the current source, specification,
job admission and fixed archive objects. An independent review confirmed:

- Target creation has a `SUCCEEDED` execution record at 14:30:02.238 UTC.
- Candidate-use allocation, request and authorization exist. Its authorization
  was issued at 14:48:50.067 UTC and expired at 14:53:50.067 UTC: exactly five
  minutes. The authorization file mtime is 14:48:51.981 UTC.
- There is no candidate-use consumption slot or journal execution record in
  the bounded store inventory. The sole current consumption is target-create.
- The final session record is `INTERRUPTED_UNKNOWN` at 14:57:57.728 UTC, which
  is 247.661 seconds after the authorization expired. This does **not** prove
  when consume checked the signature or identify the first failure.
- Both source attempt and manifest readbacks are absent in the main archive
  and independent backup. Forty-one operation locks remain preserved.
- The specification and job admission expire at 04:00 UTC on October 16.
  That outer deadline is separate from the five-minute signature lifetime.

The diagnostic reports `H1_CALLER / EXECUTION / R3_TARGET_CREATE_UNAVAILABLE`.
The source-manifest catch discarded its inner cause, so the exact first failure
cannot be reconstructed from that report. The retained GitHub diagnostic is
truncated; its successful tail does not exclude an earlier network error.

Safe original output SHA-256 values:

- State inventory: `99067e80986e623ee817bd57ea729f486bd6aba7a1c9cb2d2a742a32ef2c7f0c`.
- Fixed-object time readback: `fe3b14460b6a1e0b1dd21c8bf5ff113a1e823d52bbb8ade2ec96c4785b42ba6e`.

Independent post-inspection readback confirmed the host lock idle and both
encrypted mounts and mappers closed. This is host protection cleanup, not proof
that all remote database resources were removed. No incident locks were moved.

## Corrections and classification

| Finding                                                                                                                                              | Classification                                                                 | Correction or required check                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An expensive resource recheck ran after signing and before consumption. A six-minute recheck deterministically exhausts a five-minute authorization. | Reproduced orchestration defect; actual incident first cause remains unproven. | Move that existing check immediately before signing. Preserve the first check, all consume checks and the resource check before source tests start.         |
| Source-manifest catch replaced a trusted inner diagnostic with a generic code; a failed UNKNOWN write could also hide the primary error.             | Confirmed code defect.                                                         | Preserve the existing trusted diagnostic projection and record the secondary write failure only as a sanitized cleanup code. Keep the public error generic. |
| Local budgets/spec-path failures from the previous RC.                                                                                               | Previous local control defects, already corrected.                             | Reuse the successful current render/freeze evidence; do not diagnose this native execution failure as another descriptor error.                             |
| Preserved consumption, UNKNOWN session and 41 locks.                                                                                                 | Actual incident state, not harmless test residue.                              | Retain history and reconcile exact resources before a separately authorized disposition; never delete history to make a test pass.                          |
| GitHub/SSH jitter or unstable UI location.                                                                                                           | Not established as this incident's cause.                                      | Use exact run/job/object identifiers and retained first-failure evidence; do not classify generic failures as environmental.                                |

The fix does not extend signature lifetimes, remove consume checks, renew a
signature, retry a consumed operation or change business behavior. It also does
not claim that the roughly 100-minute preparation cost has been solved.

## Bounded validation and next entry

Two behavior regressions failed on the old ordering: the delayed resource check
expired the signature, and a failed pre-consume check had already issued one.
After moving the check, the private production entrypoint passes those cases
and still makes only one sign/consume attempt. Source-manifest regressions
preserve the inner cause, preserve it across a failed UNKNOWN write, and reject
changed resources after consumption before any source attempt is written.
The adjacent diagnostic tests also pass: 19 tests total, with no remote RC.

Prisma validation passes. Local migration status requires the external
datasource configuration; a fresh read-only query using the existing server
container configuration confirms 126 applied migrations. The two approved
Stage1 closure migrations remain pending. No schema or business change was made.

Before another RC, finish exact incident reconciliation and review the phase
budget and the corrected signing boundary. Preserve reusable build, RAM,
signature/archive and snapshot-admission evidence according to their bindings;
this document does not transfer old signatures to changed source. Keep the
held snapshot data job unstarted until its actual source prerequisites pass.
Do not use another long RC as the first test of these known failure classes.

## Follow-up inspection on October 16 (Beijing)

The signing-order and diagnostic fix merged as PR 363, main commit
`119c6bc66a2599b0d3adbe532d9787b79975f969`. Main CI `38763756944`
completed successfully. This validates the code checks, not the failed RC.

A bounded protected read authenticated all 41 original lock files against
the previous inventory and the fixed destination record: two forward locks,
37 database target locks and two lifecycle reservation locks. All remain in
place. Independent post-read observations found the host lock idle, both
encrypted mounts/mappers closed, the prior owner process absent, and both
transport key files empty. The lock readback raw SHA-256 is
`ea8753d696c0f4f4f1673cf91706b720294f3d27346e6b78024caa269ed11fea`.

The legacy incident disposition cannot be copied for this case: it expects
one UNKNOWN execution, no retained session locks, and unknown remote creation.
This case has a successful target-create pair, an UNKNOWN session, and a
signed but unconsumed candidate-use. The proposed exact disposition must
retain the 39 target/reservation locks and state known creation, unproved
remote cleanup, and no promotion eligibility. Only the two forward originals
may be considered for retirement after a separate exact owner approval.

A bounded offline correction reuses the postgres administration connection
within one resource inspection. Its actual private-function regression changes
37-target connection opens from 74 to 38 while retaining all 74 fresh credential
and identity checks and all 148 observation SELECTs. It reduces connection
setup statements from 222 to 114. These are trace counts, not measured remote
elapsed-time improvements. Full GitHub/trust checks remain unchanged.

During offline review, synthetic incident fixtures initially missed the real
authorization envelope (`payload.schemaVersion`) and the different identity
shape of reservation locks. These are test-fixture defects, not environment
jitter. Fixtures and assessors must match the production schema, and the exact
retained graph must be assessed read-only before any signed disposition. An
extra candidate-use consumption must be rejected even when it appears only
in the graph and is omitted from a caller-supplied consumption array.

No new candidate, signature, build, or RC is authorized by these checks. No
source proof, cleanup proof, terminal acknowledgement, or successful R3
segment may be fabricated from this incomplete operation.

The actual protected graph assessment subsequently passed with the exact
12 originals and 39 target locks; both forward locks remained active. Output
SHA-256 is `cc371fd352246edd0d1a7315988d1a90530f27384cbe610bea6c396540e5572f`.
The subsequent host-protection readback confirmed empty transport key files,
closed encrypted volumes and absence of the old owner PID; it did not check
formal transport idleness. A later bounded read-only inspection found
processes 9934 and 9943, a tmpfs mount, a 55,305-byte duplicate
`creation.bundle` with the same SHA-256 as the encrypted-volume copy, and
listeners on ports 55440 and 55441. The disposition Execute public preflight
therefore stopped before creating its once record. These concrete transport
remnants require separate reconciliation; neither empty key files nor closed
encrypted volumes establish formal transport IDLE, and no environment jitter
is inferred.
This is a pure graph assessment, not a native historical receipt or cleanup
proof. The native reader additionally requires the exact incident policy,
original 233d source/catalog binding, signed disposition and normal destination,
observation and custody verification.

The real R3 sign/consume path also needs a separate timing gate: `issuedAt`
precedes context lookup and persistence; consumption repeats request, history
and context validation before checking the authorization. The mocked ordering
regression does not establish that this complete path fits 300 seconds. A
read-only measurement of the production historical path must precede another RC.

On October 16 the user delegated subsequent RAM changes and closure-aligned
plans without separate per-plan approval. Record that standing authority and
the concrete plan truthfully, review and pin execution inputs, and retain the
failure reconciliation and real terminal acknowledgement requirements. This
changes the approval workflow; it does not convert failed evidence into success.
