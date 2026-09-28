# R3 hosted evidence handoff

Continue the approved R3 target policy: connect actual hosted observations to
the existing H1 fixed readers before destination admission. This changes no
business flow, signing profile, manual capability, cloud service or KMS choice.

## Implementation

- [x] Build and verify one bounded, canonical, job-key-signed evidence bundle.
      Reuse the existing workspace binding/report validator and retain Engine
      and managed-containerd originals with matching digests. This is evidence,
      not another authorization mechanism or a creation success record.
- [x] Expose an exporter on the existing hosted control handle. It uses a
      private copy of its own creation result, the admitted job's key and live
      rechecks; callers cannot replace the observed result.
- [x] Import verified bytes create-only beneath the fixed H1 operation path.
      Reserve `observations/active` and `observations/absent` before opening job
      handles. The workspace reader uses these child directories so imports
      cannot invalidate the pinned parent of `job-admission.json`.
- [x] Connect import/readback to the existing H1 launch handle, compare the
      signed Engine to the current forwarded Engine, and retain the observation
      handle for later rechecks. Keep UNKNOWN and consumed locks unchanged.
- [x] Run the affected helper, hosted-control and H1 workspace/import tests,
      verify contracts and record limitations. No R2 long-chain reruns.

The bundle is at most 1 MiB and contains nonsecret observation bytes only.
Existing owner/CI artifact delivery can carry it; no new network port, remote
shell permission or permanent service is added. Actual workflow delivery and
creation success/consumer/cleanup still need connection after these endpoints.

Import attempts retain partial originals on failure and refuse overwrite.
The fixed profile and current job remain authoritative. Native H1 checks must
run before any private write; an imported signature alone grants no DB or
snapshot access.

Preflight: clean `c714a3f6`. `a5de54` migration status exit 1, exact missing
`datasource.url` message (URL/dotenv disabled, no DB); `e75cf6` Prisma validate
exit 0. Changes are confined to release infrastructure.

Verification: package whole-file 8/8 (`bcca5e`, 1,604.0763 ms); the new
valid-signature/contradictory-parent regression failed first (`b90a45`, 7/8).
Native combined `r3-evidence-native02.log` exited 0 (`ebcfeb`), 16/16,
0 skipped, 148,698.816965 ms. It covers real Linux files, sockets and processes
with synthetic hosted/GitHub/Engine evidence, not a real hosted deployment.
The first native run failed before H1 tests because the private copy omitted
two dependencies; its log remains `r3-evidence-native01.log`.

The bounded review found that raw digests alone did not prove consistency
with declared containerd facts. Both collector and importer now use the same
pure raw parser; the review accepted the fix. Subsequent edits to those tested
sources were formatting only. Final contracts (`3209a5`): 217 files, 83 schemas,
128 migrations, 13 commands; repository digest
`sha256:abe771e857b90823df9d32f9484d09de1b3e3c6fa1caa0c05143adab59751bf5`.
Discovery (`9d8c8e`): 99 candidates, 39 manifested, 60 excepted, 0 unclassified;
no new database suite or exception. Syntax, formatting and diff checks passed.
No R2 long chain, live database change, service startup or workflow dispatch.
