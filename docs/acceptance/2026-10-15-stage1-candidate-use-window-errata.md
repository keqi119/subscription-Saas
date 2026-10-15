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
